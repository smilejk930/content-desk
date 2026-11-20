import type { SponsorshipInfo } from './manuscript.js';

export interface ContentHashImageRef {
  seq: number;
  r2_key: string;
  caption: string;
  is_ai_generated: boolean;
}

export interface ContentHashInput {
  selected_title: string;
  body_html: string;
  images: readonly ContentHashImageRef[];
  tags: readonly string[];
  sponsorship: SponsorshipInfo;
  ftc_disclosure: string | null;
  ai_disclosure: string | null;
  visibility: '전체공개' | '이웃공개';
  naver_board_name: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const result: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      result[k] = canonicalize(v);
    }
    return result;
  }
  return value;
}

export function serializeContentHashInput(input: ContentHashInput): string {
  const normalized = {
    selected_title: input.selected_title.trim(),
    body_html: input.body_html,
    images: [...input.images]
      .sort((a, b) => a.seq - b.seq)
      .map((img) => ({
        seq: img.seq,
        r2_key: img.r2_key,
        caption: img.caption.trim(),
        is_ai_generated: img.is_ai_generated
      })),
    tags: input.tags.map((t) => t.trim()),
    sponsorship: {
      is_sponsored: input.sponsorship.is_sponsored,
      provider_name: input.sponsorship.provider_name?.trim() ?? null,
      compensation_type: input.sponsorship.compensation_type?.trim() ?? null
    },
    ftc_disclosure: input.ftc_disclosure?.trim() ?? null,
    ai_disclosure: input.ai_disclosure?.trim() ?? null,
    visibility: input.visibility,
    naver_board_name: input.naver_board_name.trim()
  };
  return JSON.stringify(canonicalize(normalized));
}

export async function computeContentHash(input: ContentHashInput): Promise<string> {
  const payload = serializeContentHashInput(input);
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
