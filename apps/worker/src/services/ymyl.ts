import type { D1Database } from '@cloudflare/workers-types';
import {
  checkYmylPrimary,
  GEMINI_TEXT_MODEL,
  type YmylCategory
} from '@content-desk/shared';
import { AppError } from '../middleware/error-handler.js';
import {
  reserveProviderQuota,
  settleSingleProviderQuota
} from './quota-ledger.js';

export type YmylEvaluationStatus =
  | 'SAFE'
  | 'BORDERLINE_PENDING'
  | 'BORDERLINE_CONFIRMED'
  | 'BLOCKED';

export interface YmylEvaluationResult {
  status: YmylEvaluationStatus;
  stage: 'primary' | 'secondary' | 'secondary_error';
  matchedTerms: string[];
  categories: YmylCategory[];
  reason: string | null;
  secondaryChecked: boolean;
}

export interface YmylEvaluateOptions {
  db?: D1Database;
  ownerUid?: string;
  geminiApiKey?: string;
  confirmBorderline?: boolean;
  now?: Date;
}

/**
 * Phase 3: YMYL 2차 Gemini 분류기 + quota_ledger · usage_daily 연동 활성화.
 */
const SECONDARY_YMYL_ENABLED = true;

const GEMINI_YMYL_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

function stripJsonFences(rawText: string): string {
  return rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseSecondaryVerdict(rawText: string): {
  verdict: 'SAFE' | 'BORDERLINE' | 'BLOCKED';
  reason: string;
} | null {
  try {
    const parsed = JSON.parse(stripJsonFences(rawText)) as {
      verdict?: unknown;
      reason?: unknown;
    };
    if (
      parsed.verdict !== 'SAFE' &&
      parsed.verdict !== 'BORDERLINE' &&
      parsed.verdict !== 'BLOCKED'
    ) {
      return null;
    }
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
        ? parsed.reason.trim().slice(0, 200)
        : '';
    return { verdict: parsed.verdict, reason };
  } catch {
    return null;
  }
}

interface BatchVerdictItem {
  keyword: string;
  verdict: 'SAFE' | 'BORDERLINE' | 'BLOCKED';
  reason: string;
}

const VERDICT_SEVERITY: Readonly<Record<'SAFE' | 'BORDERLINE' | 'BLOCKED', number>> = {
  SAFE: 1,
  BORDERLINE: 2,
  BLOCKED: 3
};

function parseBatchSecondaryVerdicts(rawText: string): BatchVerdictItem[] | null {
  try {
    const parsed = JSON.parse(stripJsonFences(rawText)) as
      | BatchVerdictItem[]
      | { items?: BatchVerdictItem[]; results?: BatchVerdictItem[] };
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.results)
          ? parsed.results
          : null;
    if (!list) return null;

    const out: BatchVerdictItem[] = [];
    for (const item of list) {
      if (
        !item ||
        typeof item.keyword !== 'string' ||
        (item.verdict !== 'SAFE' && item.verdict !== 'BORDERLINE' && item.verdict !== 'BLOCKED')
      ) {
        return null;
      }
      out.push({
        keyword: item.keyword.trim(),
        verdict: item.verdict,
        reason:
          typeof item.reason === 'string' && item.reason.trim().length > 0
            ? item.reason.trim().slice(0, 200)
            : ''
      });
    }
    return out;
  } catch {
    return null;
  }
}

async function callGeminiYmyl(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch(GEMINI_YMYL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!res.ok) {
    throw new AppError(
      503,
      'YMYL_SECONDARY_UNAVAILABLE',
      `YMYL 2차 AI 판정 응답 오류(HTTP ${res.status})로 통과가 차단되었습니다.`
    );
  }

  const body = (await res.json()) as GeminiGenerateContentResponse;
  return body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
}

/**
 * 단일 주제/카테고리 YMYL 2중 판정:
 * 1) 1차 키워드 차단 즉시 실행 (차단 시 Gemini 예약·호출 없음)
 * 2) GEMINI_API_KEY 미설정 또는 gemini_text 할당량 소진 시 통과 차단
 * 3) 2차 Gemini 판정 (SAFE / BORDERLINE / BLOCKED) + res.ok 성공 후에만 actualUsed=1 정산
 */
export async function evaluateYmyl(
  input: string | readonly string[],
  options: YmylEvaluateOptions = {}
): Promise<YmylEvaluationResult> {
  const texts = (Array.isArray(input) ? input : [input])
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const primary = checkYmylPrimary(texts);

  if (primary.blocked) {
    return {
      status: 'BLOCKED',
      stage: 'primary',
      matchedTerms: primary.matchedTerms,
      categories: primary.categories,
      reason: `YMYL 금지 주제(${primary.matchedTerms.join(', ')})는 등록할 수 없습니다.`,
      secondaryChecked: false
    };
  }

  if (!SECONDARY_YMYL_ENABLED) {
    throw new AppError(
      503,
      'YMYL_SECONDARY_UNAVAILABLE',
      'YMYL 2차 AI 검사가 비활성화되어 통과할 수 없습니다.'
    );
  }

  const apiKey = options.geminiApiKey?.trim() ?? '';
  if (!apiKey) {
    throw new AppError(
      503,
      'YMYL_SECONDARY_UNAVAILABLE',
      'GEMINI_API_KEY가 설정되지 않아 YMYL 2차 AI 검사를 수행할 수 없습니다. 등록·확정이 차단되었습니다.'
    );
  }

  if (texts.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'YMYL 검사 대상 텍스트가 비어 있습니다.');
  }

  const now = options.now ?? new Date();
  const reservation =
    options.db
      ? await reserveProviderQuota(options.db, {
          provider: 'gemini_text',
          amount: 1,
          now
        })
      : null;

  let actualUsed = 0;
  try {
    const prompt = [
      '당신은 네이버 블로그 콘텐츠의 YMYL(Your Money or Your Life) 주제 차단 분류기입니다.',
      '차단 대상(BLOCKED): 의료·건강·질병·처방·약품, 금융·투자·주식·코인·가상자산·대출·보험·세금·부동산 청약, 법률·소송.',
      '경계 사례(BORDERLINE): 여행자 보험, 건강 습관, 소비/지출 절약 팁 등 맥락에 따라 YMYL에 걸칠 수 있는 주제.',
      '안전 대상(SAFE): 일반 테크/IT, 제품 후기, 여행, 맛집/카페, 취미, 일상 브이로그 등 비YMYL 주제.',
      '반드시 아래 JSON 형식 한 줄로만 응답하세요:',
      '{"verdict":"SAFE"|"BORDERLINE"|"BLOCKED","reason":"한국어 1문장 사유"}',
      '',
      '검사 대상 텍스트:',
      ...texts.map((t, idx) => `${idx + 1}. ${t}`)
    ].join('\n');

    // res.ok 확인 이후(callGeminiYmyl 정상 반환 시)에만 actualUsed를 1로 누적
    const rawText = await callGeminiYmyl(prompt, apiKey);
    actualUsed = 1;

    const parsed = parseSecondaryVerdict(rawText);
    if (!parsed) {
      throw new AppError(
        503,
        'YMYL_SECONDARY_UNAVAILABLE',
        'YMYL 2차 AI 판정 응답 형식을 해석할 수 없어 통과가 차단되었습니다.'
      );
    }

    if (parsed.verdict === 'BLOCKED') {
      return {
        status: 'BLOCKED',
        stage: 'secondary',
        matchedTerms: [],
        categories: [],
        reason: parsed.reason || '2차 AI 분류기에서 고위험 YMYL 주제로 판정되었습니다.',
        secondaryChecked: true
      };
    }

    if (parsed.verdict === 'BORDERLINE') {
      return {
        status: options.confirmBorderline ? 'BORDERLINE_CONFIRMED' : 'BORDERLINE_PENDING',
        stage: 'secondary',
        matchedTerms: [],
        categories: [],
        reason: parsed.reason || 'YMYL 경계 사례로 분류되어 작성자 확인이 필요합니다.',
        secondaryChecked: true
      };
    }

    return {
      status: 'SAFE',
      stage: 'secondary',
      matchedTerms: [],
      categories: [],
      reason: parsed.reason || null,
      secondaryChecked: true
    };
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError(
      503,
      'YMYL_SECONDARY_UNAVAILABLE',
      'YMYL 2차 AI 판정 호출 중 네트워크 오류가 발생하여 통과가 차단되었습니다.'
    );
  } finally {
    if (options.db && reservation) {
      await settleSingleProviderQuota(options.db, {
        ownerUid: options.ownerUid ?? 'system',
        reservation,
        actualUsed,
        d1Reads: 1,
        d1Writes: 0,
        now
      });
    }
  }
}

/**
 * 카테고리 등록/수정 및 글감 확정용 가드:
 * - BLOCKED -> 422 YMYL_BLOCKED
 * - BORDERLINE_PENDING (confirm_borderline 미전달) -> 409 YMYL_BORDERLINE_CONFIRM_REQUIRED
 * - GEMINI_API_KEY 미설정 -> 503 YMYL_SECONDARY_UNAVAILABLE
 * - 할당량 초과 -> 429 QUOTA_EXCEEDED
 */
export async function assertNonYmylOrThrow(
  input: string | readonly string[],
  options: YmylEvaluateOptions = {}
): Promise<YmylEvaluationResult> {
  const result = await evaluateYmyl(input, options);

  if (result.status === 'BLOCKED') {
    throw new AppError(
      422,
      'YMYL_BLOCKED',
      result.reason ?? 'YMYL(의료·건강·금융·투자·법률 등) 주제는 정책상 등록할 수 없습니다.',
      {
        details: {
          stage: result.stage,
          matched_terms: result.matchedTerms,
          categories: result.categories
        }
      }
    );
  }

  if (result.status === 'BORDERLINE_PENDING') {
    throw new AppError(
      409,
      'YMYL_BORDERLINE_CONFIRM_REQUIRED',
      result.reason ??
        'YMYL 경계 사례로 판정되었습니다. 비YMYL 주제임을 확인한 뒤 재요청해 주세요.',
      {
        details: {
          stage: result.stage,
          ymyl_status: 'BORDERLINE_PENDING',
          reason: result.reason,
          confirm_field: 'confirm_borderline'
        }
      }
    );
  }

  return result;
}

export interface BatchYmylDecision {
  keyword: string;
  status: 'SAFE' | 'BORDERLINE_PENDING' | 'BLOCKED';
  stage: 'primary' | 'secondary' | 'secondary_error';
  reason: string | null;
}

/**
 * 글감 발굴 Step 1 전용 배치 2중 판정:
 * - 1차 키워드 차단은 즉시 걸러내고(Gemini 호출 0회)
 * - 1차를 통과한 후보 전체를 Gemini 1회 배치 호출로 판정해 무료 티어 호출 수를 절약합니다.
 * - 배치 응답에 동일 키워드가 중복 포함된 경우 가장 엄격한 판정(BLOCKED > BORDERLINE > SAFE)을 채택합니다.
 */
export async function evaluateYmylBatchForKeywords(
  keywords: readonly string[],
  options: {
    db: D1Database;
    ownerUid: string;
    geminiApiKey?: string;
    now?: Date;
  }
): Promise<BatchYmylDecision[]> {
  const decisions = new Map<string, BatchYmylDecision>();
  const stage2Candidates: string[] = [];

  for (const raw of keywords) {
    const keyword = raw.trim();
    if (!keyword || decisions.has(keyword)) continue;

    const primary = checkYmylPrimary(keyword);
    if (primary.blocked) {
      decisions.set(keyword, {
        keyword,
        status: 'BLOCKED',
        stage: 'primary',
        reason: `YMYL 1차 차단 키워드(${primary.matchedTerms.join(', ')}) 감지`
      });
    } else {
      stage2Candidates.push(keyword);
    }
  }

  if (stage2Candidates.length === 0) {
    return [...decisions.values()];
  }

  const apiKey = options.geminiApiKey?.trim() ?? '';
  if (!apiKey) {
    throw new AppError(
      503,
      'YMYL_SECONDARY_UNAVAILABLE',
      'GEMINI_API_KEY가 설정되지 않아 글감 발굴 YMYL 2차 AI 검사를 수행할 수 없습니다.'
    );
  }

  const now = options.now ?? new Date();
  const reservation = await reserveProviderQuota(options.db, {
    provider: 'gemini_text',
    amount: 1,
    now
  });

  let actualUsed = 0;
  try {
    const prompt = [
      '당신은 네이버 블로그 글감 후보의 YMYL(Your Money or Your Life) 배치 분류기입니다.',
      '차단(BLOCKED): 의료·건강·질병·처방·약품, 금융·투자·주식·코인·대출·보험·세금·부동산 청약, 법률·소송.',
      '경계(BORDERLINE): 여행자 보험, 건강 습관 등 맥락 확인이 필요한 경계 주제.',
      '안전(SAFE): 일반 테크/IT, 제품 후기, 여행, 맛집, 취미, 일상 브이로그 등 비YMYL 주제.',
      '반드시 아래 JSON 배열만 반환하세요:',
      '[{"keyword":"원본 키워드","verdict":"SAFE"|"BORDERLINE"|"BLOCKED","reason":"한국어 1문장 사유"}]',
      '',
      '검사할 키워드 목록:',
      ...stage2Candidates.map((k, idx) => `${idx + 1}. ${k}`)
    ].join('\n');

    // res.ok 확인 이후에만 actualUsed를 1로 누적
    const rawText = await callGeminiYmyl(prompt, apiKey);
    actualUsed = 1;

    const parsed = parseBatchSecondaryVerdicts(rawText);
    if (!parsed) {
      throw new AppError(
        503,
        'YMYL_SECONDARY_UNAVAILABLE',
        'YMYL 2차 배치 판정 응답 형식을 해석할 수 없어 통과가 차단되었습니다.'
      );
    }

    // 동일 키워드 중복 응답 시 가장 엄격한 판정(BLOCKED > BORDERLINE > SAFE) 유지
    const byKeyword = new Map<string, BatchVerdictItem>();
    for (const item of parsed) {
      const prev = byKeyword.get(item.keyword);
      if (!prev || VERDICT_SEVERITY[item.verdict] > VERDICT_SEVERITY[prev.verdict]) {
        byKeyword.set(item.keyword, item);
      }
    }

    for (const keyword of stage2Candidates) {
      const verdictItem = byKeyword.get(keyword);
      if (!verdictItem) {
        decisions.set(keyword, {
          keyword,
          status: 'BLOCKED',
          stage: 'secondary_error',
          reason: 'YMYL 2차 판정 결과에 포함되지 않아 안전을 위해 차단했습니다.'
        });
        continue;
      }

      if (verdictItem.verdict === 'BLOCKED') {
        decisions.set(keyword, {
          keyword,
          status: 'BLOCKED',
          stage: 'secondary',
          reason: verdictItem.reason || '2차 AI 분류기에서 YMYL 주제로 판정되었습니다.'
        });
      } else if (verdictItem.verdict === 'BORDERLINE') {
        decisions.set(keyword, {
          keyword,
          status: 'BORDERLINE_PENDING',
          stage: 'secondary',
          reason: verdictItem.reason || 'YMYL 경계 사례로 작성자 확인이 필요합니다.'
        });
      } else {
        decisions.set(keyword, {
          keyword,
          status: 'SAFE',
          stage: 'secondary',
          reason: verdictItem.reason || null
        });
      }
    }

    return keywords
      .map((k) => decisions.get(k.trim()))
      .filter((d): d is BatchYmylDecision => d !== undefined);
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError(
      503,
      'YMYL_SECONDARY_UNAVAILABLE',
      'YMYL 2차 배치 판정 호출 중 오류가 발생하여 통과가 차단되었습니다.'
    );
  } finally {
    await settleSingleProviderQuota(options.db, {
      ownerUid: options.ownerUid,
      reservation,
      actualUsed,
      d1Reads: 1,
      d1Writes: 0,
      now
    });
  }
}
