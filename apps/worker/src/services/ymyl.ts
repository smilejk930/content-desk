import { checkYmylPrimary, type YmylCategory } from '@content-desk/shared';
import { AppError } from '../middleware/error-handler.js';

export type YmylEvaluationStatus = 'SAFE' | 'BORDERLINE_PENDING' | 'BLOCKED';

export interface YmylEvaluationResult {
  status: YmylEvaluationStatus;
  stage: 'primary' | 'primary_only' | 'secondary' | 'secondary_error';
  matchedTerms: string[];
  categories: YmylCategory[];
  reason: string | null;
  secondaryChecked: boolean;
}

/**
 * Phase 2에서는 quota_ledger·usage_daily가 아직 구현되지 않았으므로,
 * GEMINI_API_KEY가 환경에 있더라도 2차 Gemini 외부 API 호출 경로를 비활성화하고
 * 1차 키워드 차단만 수행합니다.
 * 2차 LLM 분류 및 BORDERLINE_PENDING 확인 플로우(409/422 + 확인 플래그)는
 * Phase 3에서 quota_ledger·usage_daily와 함께 활성화합니다.
 */
const SECONDARY_YMYL_ENABLED: boolean = false;

const GEMINI_YMYL_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

function parseSecondaryVerdict(rawText: string): {
  verdict: 'SAFE' | 'BORDERLINE' | 'BLOCKED';
  reason: string;
} | null {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as { verdict?: unknown; reason?: unknown };
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

async function runSecondaryGeminiClassifier(
  texts: readonly string[],
  apiKey: string
): Promise<{ status: YmylEvaluationStatus; stage: 'secondary' | 'secondary_error'; reason: string | null }> {
  const prompt = [
    '당신은 네이버 블로그 콘텐츠의 YMYL(Your Money or Your Life) 주제 차단 분류기입니다.',
    '차단 대상: 의료·건강·질병·처방·약품, 금융·투자·주식·코인·가상자산·대출·보험·세금·부동산 청약, 법률·소송.',
    '비차단 대상: 일반 테크/IT, 제품 후기, 여행, 맛집/카페, 취미, 일상 브이로그 등 비YMYL 주제.',
    '반드시 아래 JSON 형식 한 줄로만 응답하세요:',
    '{"verdict":"SAFE"|"BORDERLINE"|"BLOCKED","reason":"한국어 1문장 사유"}',
    '',
    '검사 대상 텍스트:',
    ...texts.map((t, idx) => `${idx + 1}. ${t}`)
  ].join('\n');

  try {
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
      return {
        status: 'BLOCKED',
        stage: 'secondary_error',
        reason: 'YMYL 2차 AI 판정 응답 오류가 발생하여 안전을 위해 차단했습니다.'
      };
    }

    const body = (await res.json()) as GeminiGenerateContentResponse;
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const parsed = parseSecondaryVerdict(text);
    if (!parsed) {
      return {
        status: 'BLOCKED',
        stage: 'secondary_error',
        reason: 'YMYL 2차 AI 판정 결과를 해석할 수 없어 안전을 위해 차단했습니다.'
      };
    }

    if (parsed.verdict === 'BLOCKED') {
      return {
        status: 'BLOCKED',
        stage: 'secondary',
        reason: parsed.reason || '2차 AI 분류기에서 고위험 YMYL 주제로 판정되었습니다.'
      };
    }

    if (parsed.verdict === 'BORDERLINE') {
      return {
        status: 'BORDERLINE_PENDING',
        stage: 'secondary',
        reason: parsed.reason || 'YMYL 경계 사례로 분류되었습니다.'
      };
    }

    return {
      status: 'SAFE',
      stage: 'secondary',
      reason: parsed.reason || null
    };
  } catch {
    return {
      status: 'BLOCKED',
      stage: 'secondary_error',
      reason: 'YMYL 2차 AI 판정 호출 중 오류가 발생하여 안전을 위해 차단했습니다.'
    };
  }
}

export async function evaluateYmyl(
  input: string | readonly string[],
  options?: { geminiApiKey?: string }
): Promise<YmylEvaluationResult> {
  const texts = (Array.isArray(input) ? input : [input]).filter((t) => t.trim().length > 0);
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

  // Phase 2: quota_ledger·usage_daily 미구현으로 2차 Gemini 외부 API 호출 경로를 비활성화합니다.
  // 2차 LLM 분류 및 BORDERLINE_PENDING 확인 플로우(409/422 + 확인 플래그)는
  // Phase 3에서 quota_ledger·usage_daily와 함께 활성화합니다.
  if (!SECONDARY_YMYL_ENABLED) {
    return {
      status: 'SAFE',
      stage: 'primary_only',
      matchedTerms: [],
      categories: [],
      reason: null,
      secondaryChecked: false
    };
  }

  const apiKey = options?.geminiApiKey?.trim() ?? '';
  if (!apiKey || texts.length === 0) {
    return {
      status: 'SAFE',
      stage: 'primary_only',
      matchedTerms: [],
      categories: [],
      reason: null,
      secondaryChecked: false
    };
  }

  const secondary = await runSecondaryGeminiClassifier(texts, apiKey);
  return {
    status: secondary.status,
    stage: secondary.stage,
    matchedTerms: [],
    categories: [],
    reason: secondary.reason,
    secondaryChecked: true
  };
}

/**
 * 1차(및 Phase 3 활성화 시 2차) YMYL 평가 결과가 BLOCKED이면 422 YMYL_BLOCKED를 발생시킵니다.
 * 2차 LLM 분류 및 BORDERLINE_PENDING 확인 플로우(409/422 + 확인 플래그)는
 * Phase 3에서 quota_ledger·usage_daily와 함께 활성화합니다.
 */
export async function assertNonYmylOrThrow(
  input: string | readonly string[],
  options?: { geminiApiKey?: string }
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
  return result;
}
