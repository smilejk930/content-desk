import {
  formatImageMarker,
  GEMINI_TEXT_MODEL,
  getProviderDailyCap,
  MAX_AI_PROMPT_EXCERPT_BYTES,
  type ContentType,
  type SponsorshipInfo
} from '@content-desk/shared';
import { AppError } from '../middleware/error-handler.js';
import { truncateTextToUtf8Bytes } from './source-snapshot.js';

export interface LlmSourceExcerptInput {
  source_id: string;
  url: string;
  domain: string;
  excerpt: string;
}

export interface LlmPhotoInput {
  seq: number;
  caption: string;
  taken_at: string | null;
}

export interface ManuscriptDraftPromptInput {
  keyword: string;
  contentType: ContentType;
  categoryName: string;
  naverBoardName: string;
  sponsorship: SponsorshipInfo;
  ftcDisclosure: string | null;
  sources: readonly LlmSourceExcerptInput[];
  fieldMemo: string | null;
  photos: readonly LlmPhotoInput[];
}

export interface LlmRawClaim {
  claim: string;
  source_id: string | null;
  quote: string | null;
}

export interface LlmDraftOutput {
  title_candidates: string[];
  selected_title: string;
  body_html: string;
  tags: string[];
  claims: LlmRawClaim[];
}

export interface LlmAdapter {
  readonly providerName: string;
  readonly textModel: string;
  generateManuscriptDraft(input: ManuscriptDraftPromptInput): Promise<LlmDraftOutput>;
}

const GEMINI_TEXT_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;

interface GeminiResponsePayload {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

function stripJsonCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function buildManuscriptPrompt(input: ManuscriptDraftPromptInput): string {
  const lines: string[] = [
    '당신은 네이버 블로그 원고 작성 보조 AI입니다. 반드시 사실 근거에 기반해 한국어 원고 초안을 작성하세요.',
    `콘텐츠 형식: ${input.contentType}`,
    `카테고리: ${input.categoryName} (게시판: ${input.naverBoardName})`,
    `주제 키워드: ${input.keyword}`,
    '',
    '[필수 출력 규칙]',
    '1. 반드시 JSON 객체 한 개만 반환하세요:',
    '{"title_candidates":["제목1","제목2","제목3"],"selected_title":"제목1","body_html":"<p>...</p>","tags":["태그1"],"claims":[{"claim":"사실 주장","source_id":"출처ID","quote":"출처 원문 그대로 발췌"}]}',
    '2. body_html에는 오직 <p>, <h2>, <h3>, <strong>, <ul>, <ol>, <li>, <blockquote>, <a>, <br> 태그만 사용하세요. style/onclick/script/img 태그는 절대 넣지 마세요.',
    '3. 제공된 근거(출처 스냅샷 또는 작성자 메모)에 없는 수치·가격·사양·날짜·장소·경험을 지어내지 마세요.',
    '4. 사실 주장(특히 숫자·가격·사양·날짜)은 claims 배열에 source_id와 원문 그대로의 quote를 함께 기록하세요.'
  ];

  if (input.ftcDisclosure) {
    lines.push(`5. 협찬 글이므로 본문 첫머리에 공정위 문구를 그대로 포함하세요: ${input.ftcDisclosure}`);
  }

  if (input.contentType === 'explainer') {
    lines.push('', '[1차 출처 스냅샷 발췌 (각 최대 5KB)]');
    for (const src of input.sources) {
      const safeExcerpt = truncateTextToUtf8Bytes(src.excerpt, MAX_AI_PROMPT_EXCERPT_BYTES);
      lines.push(`--- source_id: ${src.source_id} | url: ${src.url} ---`);
      lines.push(safeExcerpt);
    }
  } else {
    lines.push('', '[작성자 현장 메모 (근거 source_id="capture_memo")]');
    lines.push(input.fieldMemo?.trim() || '(메모 없음 - 사진 캡션만 참고)');

    if (input.photos.length > 0) {
      lines.push('', '[작성자 실사 사진 목록 - 본문 적절한 위치에 아래 마커를 정확히 삽입하세요]');
      for (const photo of input.photos) {
        const marker = formatImageMarker(photo.seq, photo.caption);
        lines.push(
          `- ${marker}${photo.taken_at ? ` (촬영: ${photo.taken_at})` : ''}`
        );
      }
    }
  }

  return lines.join('\n');
}

function parseDraftJson(rawText: string, fallbackKeyword: string): LlmDraftOutput {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonCodeFences(rawText)) as Record<string, unknown>;
  } catch {
    throw new AppError(
      502,
      'UPSTREAM_API_ERROR',
      'LLM 원고 생성 응답을 JSON으로 해석할 수 없습니다.'
    );
  }

  const rawCandidates = Array.isArray(parsed.title_candidates)
    ? parsed.title_candidates
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 120))
    : [];

  const selectedTitle =
    typeof parsed.selected_title === 'string' && parsed.selected_title.trim().length > 0
      ? parsed.selected_title.trim().slice(0, 120)
      : rawCandidates[0] ?? `${fallbackKeyword} 정리`;

  const titleCandidates =
    rawCandidates.length > 0
      ? rawCandidates.includes(selectedTitle)
        ? rawCandidates
        : [selectedTitle, ...rawCandidates]
      : [selectedTitle];

  const bodyHtml =
    typeof parsed.body_html === 'string' && parsed.body_html.trim().length > 0
      ? parsed.body_html.trim()
      : '';

  if (!bodyHtml) {
    throw new AppError(502, 'UPSTREAM_API_ERROR', 'LLM 원고 본문(body_html)이 비어 있습니다.');
  }

  const tags = Array.isArray(parsed.tags)
    ? [
        ...new Set(
          parsed.tags
            .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
            .map((t) => t.trim().replace(/^#/, '').slice(0, 30))
            .filter((t) => t.length > 0)
        )
      ].slice(0, 30)
    : [];

  const claims: LlmRawClaim[] = Array.isArray(parsed.claims)
    ? parsed.claims
        .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
        .map((c) => ({
          claim: typeof c.claim === 'string' ? c.claim.trim() : '',
          source_id: typeof c.source_id === 'string' && c.source_id.trim().length > 0 ? c.source_id.trim() : null,
          quote: typeof c.quote === 'string' && c.quote.trim().length > 0 ? c.quote.trim() : null
        }))
        .filter((c) => c.claim.length > 0)
    : [];

  return {
    title_candidates: titleCandidates,
    selected_title: selectedTitle,
    body_html: bodyHtml,
    tags,
    claims
  };
}

export class GeminiLlmAdapter implements LlmAdapter {
  readonly providerName = 'gemini_text';
  readonly textModel = GEMINI_TEXT_MODEL;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new AppError(503, 'UPSTREAM_API_ERROR', 'GEMINI_API_KEY가 설정되지 않았습니다.');
    }
    this.apiKey = trimmed;
  }

  async generateManuscriptDraft(input: ManuscriptDraftPromptInput): Promise<LlmDraftOutput> {
    const prompt = buildManuscriptPrompt(input);
    const res = await fetch(GEMINI_TEXT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!res.ok) {
      throw new AppError(
        502,
        'UPSTREAM_API_ERROR',
        `Gemini 원고 생성 호출이 실패했습니다 (HTTP ${res.status}).`
      );
    }

    const payload = (await res.json()) as GeminiResponsePayload;
    const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return parseDraftJson(text, input.keyword);
  }
}

export function createDefaultLlmAdapter(geminiApiKey: string | undefined): LlmAdapter {
  return new GeminiLlmAdapter(geminiApiKey ?? '');
}

/**
 * 0원 운영 무료 티어 원칙:
 * gemini_image 일일 상한이 0이면 이미지 생성 호출을 절대 수행하지 않습니다.
 */
export function isAiDiagramGenerationAllowed(configuredCapRaw?: string): boolean {
  const defaultCap = getProviderDailyCap('gemini_image');
  if (!configuredCapRaw) {
    return defaultCap > 0;
  }
  const parsed = Number.parseInt(configuredCapRaw, 10);
  return Number.isFinite(parsed) && parsed > 0;
}
