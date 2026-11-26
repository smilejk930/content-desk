import { z } from '../zod.js';
import { contentTypeSchema } from './category.js';
import { captureIdSchema, sponsorshipSchema } from './capture.js';

export const topicTrackSchema = z.enum(['category_discovery', 'personal_vlog']);
export const ymylStatusSchema = z.enum([
  'SAFE',
  'BORDERLINE_PENDING',
  'BORDERLINE_CONFIRMED',
  'BLOCKED'
]);
export const topicStatusSchema = z.enum([
  'DISCOVERED',
  'DATALAB_SCORED',
  'SUPPLY_SCORED',
  'READY'
]);

export type TopicTrack = z.infer<typeof topicTrackSchema>;
export type YmylStatus = z.infer<typeof ymylStatusSchema>;
export type TopicStatus = z.infer<typeof topicStatusSchema>;

export const primarySourceRefSchema = z.strictObject({
  source_id: z.string().min(1).max(64),
  url: z.url(),
  domain: z.string().min(1).max(120),
  r2_key: z.string().min(1),
  fetched_at: z.iso.datetime(),
  body_sha256: z.string().length(64),
  ingest_channel: z.enum(['webkr_search', 'manual_input']),
  char_count: z.number().int().min(0).optional()
});

export type PrimarySourceRef = z.infer<typeof primarySourceRefSchema>;

export const serpSnippetItemSchema = z.strictObject({
  title: z.string().max(200),
  snippet: z.string().max(500),
  link: z.string().max(500).optional(),
  source: z.enum(['blog', 'news'])
});

export type SerpSnippetItem = z.infer<typeof serpSnippetItemSchema>;

const topicDiscoveryBaseSchema = z.strictObject({
  topic_id: z.string().min(1).max(64),
  run_id: z.string().min(1).max(64),
  track: topicTrackSchema,
  category_id: z.string().min(1).max(64),
  content_type: contentTypeSchema,
  status: topicStatusSchema.default('READY'),
  keyword: z.string().min(1).max(120),
  capture_ids: z.array(z.string().min(1)).default([]),
  sources: z.array(primarySourceRefSchema).default([]),
  ymyl_status: ymylStatusSchema,
  ymyl_reason: z.string().max(300).nullable().optional(),
  sponsorship: sponsorshipSchema,
  datalab_demand_index: z.number().min(0).nullable(),
  blog_supply_count: z.number().int().min(0).nullable(),
  news_supply_count: z.number().int().min(0).nullable(),
  monthly_search_volume: z.number().int().min(0).nullable(),
  competition_score: z.number().min(0).nullable(),
  serp_snippets: z.array(serpSnippetItemSchema).max(30).optional(),
  created_at: z.iso.datetime()
});

function validateTopicBase(
  val: z.infer<typeof topicDiscoveryBaseSchema>,
  ctx: z.RefinementCtx,
  requireExplainerSources: boolean
) {
  if (val.track === 'personal_vlog' && val.content_type !== 'vlog') {
    ctx.addIssue({
      code: 'custom',
      path: ['content_type'],
      message: 'personal_vlog 트랙은 vlog 콘텐츠 형식만 허용됩니다.'
    });
  }
  if (val.track === 'category_discovery' && val.content_type === 'vlog') {
    ctx.addIssue({
      code: 'custom',
      path: ['content_type'],
      message: 'category_discovery 트랙에서는 vlog 형식을 사용할 수 없습니다.'
    });
  }
  if (
    requireExplainerSources &&
    val.content_type === 'explainer' &&
    val.status === 'READY' &&
    val.sources.length === 0
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['sources'],
      message: 'explainer 글감(READY)에는 1차 출처 스냅샷이 1개 이상 필요합니다.'
    });
  }
}

/**
 * 1~3단계 발굴 직후 상태(status: DISCOVERED/DATALAB_SCORED/SUPPLY_SCORED)에서는
 * explainer도 sources=[]를 허용하고, 4단계 출처 스냅샷 확보 후 READY 상태에서는
 * explainer에 sources >= 1을 필수 강제합니다.
 */
export const topicDiscoverySchema = topicDiscoveryBaseSchema.superRefine((val, ctx) =>
  validateTopicBase(val, ctx, true)
);

export const readyTopicDiscoverySchema = topicDiscoveryBaseSchema.superRefine((val, ctx) => {
  validateTopicBase(val, ctx, true);
  if (val.status !== 'READY') {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message: '원고 생성을 진행하려면 글감 상태가 READY여야 합니다.'
    });
  }
  if (val.content_type === 'explainer' && val.sources.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['sources'],
      message: 'explainer 원고 생성에는 1차 출처 스냅샷이 1개 이상 필요합니다.'
    });
  }
});

export type TopicDiscoveryJSON = z.infer<typeof topicDiscoverySchema>;

// Step 1: 시드·Google Trends 후보 수집 + YMYL 2중 판정
export const discoverStep1RequestSchema = z.strictObject({
  category_id: z.string().min(1).max(64),
  content_type: z.enum(['explainer', 'experience_review']).default('explainer'),
  extra_keywords: z.array(z.string().trim().min(1).max(80)).max(15).default([]),
  include_google_trends: z.boolean().default(true),
  run_id: z.string().min(1).max(64).optional()
});

export const blockedTopicCandidateSchema = z.strictObject({
  keyword: z.string().min(1),
  stage: z.enum(['primary', 'secondary', 'secondary_error']),
  reason: z.string().min(1)
});

export const discoverStep1ResponseSchema = z.strictObject({
  run_id: z.string().min(1).max(64),
  category_id: z.string().min(1).max(64),
  google_trends_status: z.enum(['ok', 'cached', 'backoff_skipped', 'disabled', 'error_skipped']),
  topics: z.array(topicDiscoverySchema),
  blocked_keywords: z.array(blockedTopicCandidateSchema)
});

// Step 2: 데이터랩 기준 키워드 정규화 배치 (최대 5개 그룹)
export const discoverStep2RequestSchema = z.strictObject({
  run_id: z.string().min(1).max(64),
  topic_ids: z.array(z.string().min(1).max(64)).max(20).optional()
});

export const discoverStep2ResponseSchema = z.strictObject({
  run_id: z.string().min(1).max(64),
  cache_hits: z.number().int().min(0),
  api_calls: z.number().int().min(0),
  topics: z.array(topicDiscoverySchema)
});

// Step 3: 네이버 검색 공급량 (blog/news) + 선택형 검색광고 (/keywordstool)
export const discoverStep3RequestSchema = z.strictObject({
  run_id: z.string().min(1).max(64),
  topic_ids: z.array(z.string().min(1).max(64)).max(20).optional()
});

export const discoverStep3ResponseSchema = z.strictObject({
  run_id: z.string().min(1).max(64),
  searchad_used: z.boolean(),
  topics: z.array(topicDiscoverySchema)
});

// CaptureAsset 기반 글감 생성 (experience_review / vlog)
export const topicFromCaptureRequestSchema = z.strictObject({
  capture_id: captureIdSchema,
  keyword: z.string().trim().min(1).max(120).optional(),
  sponsorship: sponsorshipSchema.optional(),
  confirm_borderline: z.boolean().optional(),
  run_id: z.string().min(1).max(64).optional()
});

// YMYL 경계 사례(BORDERLINE_PENDING) 작성자 확인
export const topicYmylConfirmRequestSchema = z.strictObject({
  confirmed: z.literal(true, {
    error: 'YMYL 경계 사례 확인 동의가 필요합니다.'
  }),
  note: z.string().trim().max(300).optional()
});

// Step 4: 1차 출처 후보 및 본문 스냅샷
export const sourceCandidateSchema = z.strictObject({
  url: z.url(),
  title: z.string().max(240),
  description: z.string().max(600),
  domain: z.string().min(1).max(120),
  matched_domain: z.string().min(1).max(120)
});

export const topicSourceCandidatesResponseSchema = z.strictObject({
  topic_id: z.string().min(1).max(64),
  allowed_domains: z.array(z.string().min(1)),
  candidates: z.array(sourceCandidateSchema)
});

export const createSourceSnapshotRequestSchema = z.strictObject({
  url: z.url({ error: '유효한 http 또는 https URL을 입력해 주세요.' }),
  ingest_channel: z.enum(['webkr_search', 'manual_input']).default('manual_input'),
  confirm_unlisted_domain: z.boolean().default(false)
});

export const createSourceSnapshotResponseSchema = z.strictObject({
  snapshot: primarySourceRefSchema.extend({
    char_count: z.number().int().min(0),
    excerpt: z.string()
  }),
  topic: topicDiscoverySchema
});

export const topicResponseSchema = z.strictObject({
  topic: topicDiscoverySchema
});

export const topicsListResponseSchema = z.strictObject({
  topics: z.array(topicDiscoverySchema)
});

export type DiscoverStep1Request = z.infer<typeof discoverStep1RequestSchema>;
export type DiscoverStep1Response = z.infer<typeof discoverStep1ResponseSchema>;
export type DiscoverStep2Request = z.infer<typeof discoverStep2RequestSchema>;
export type DiscoverStep2Response = z.infer<typeof discoverStep2ResponseSchema>;
export type DiscoverStep3Request = z.infer<typeof discoverStep3RequestSchema>;
export type DiscoverStep3Response = z.infer<typeof discoverStep3ResponseSchema>;
export type TopicFromCaptureRequest = z.infer<typeof topicFromCaptureRequestSchema>;
export type TopicYmylConfirmRequest = z.infer<typeof topicYmylConfirmRequestSchema>;
export type SourceCandidate = z.infer<typeof sourceCandidateSchema>;
export type TopicSourceCandidatesResponse = z.infer<typeof topicSourceCandidatesResponseSchema>;
export type CreateSourceSnapshotRequest = z.infer<typeof createSourceSnapshotRequestSchema>;
export type CreateSourceSnapshotResponse = z.infer<typeof createSourceSnapshotResponseSchema>;
export type TopicResponse = z.infer<typeof topicResponseSchema>;
export type TopicsListResponse = z.infer<typeof topicsListResponseSchema>;
