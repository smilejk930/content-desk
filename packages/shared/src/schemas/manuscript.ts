import { z } from '../zod.js';
import { contentTypeSchema, visibilitySchema } from './category.js';
import { capturePhotoSchema, sponsorshipSchema } from './capture.js';
import { primarySourceRefSchema, topicDiscoverySchema } from './topic.js';

export const manuscriptClaimSchema = z.strictObject({
  claim_id: z.string().min(1),
  claim: z.string().min(1),
  source_id: z.string().min(1).nullable(),
  quote: z.string().nullable(),
  verification_status: z.enum(['VERIFIED', 'VERIFY_REQUIRED', 'RESOLVED_BY_OWNER']),
  resolution_url: z.url().nullable()
});

export type ManuscriptClaim = z.infer<typeof manuscriptClaimSchema>;

export const manuscriptImageRefSchema = z.strictObject({
  seq: z.number().int().min(1).max(20),
  r2_key: z.string().min(1),
  caption: z.string().min(1).max(120),
  is_ai_generated: z.boolean()
});

export type ManuscriptImageRef = z.infer<typeof manuscriptImageRefSchema>;

export const naverBlogManuscriptBundleSchema = z.strictObject({
  manuscript_id: z.string().min(1).max(64),
  topic_id: z.string().min(1).max(64),
  version: z.number().int().min(1),
  content_hash: z.string().length(64),
  title_candidates: z.array(z.string().min(1).max(120)).min(1),
  selected_title: z.string().min(1).max(120),
  body_html: z.string().min(1),
  naver_board_name: z.string().min(1).max(60),
  sponsorship: sponsorshipSchema,
  ftc_disclosure: z.string().nullable(),
  ai_disclosure: z.string().nullable(),
  images: z.array(manuscriptImageRefSchema),
  tags: z.array(z.string().min(1).max(30)).max(30),
  visibility: visibilitySchema,
  claims: z.array(manuscriptClaimSchema),
  ngram_max_similarity: z.number().min(0).max(1).nullable(),
  sanitized_at: z.iso.datetime().nullable().optional(),
  approved_hash: z.string().length(64).nullable(),
  approved_at: z.iso.datetime().nullable()
});

export type NaverBlogManuscriptBundle = z.infer<typeof naverBlogManuscriptBundleSchema>;

export const generateManuscriptRequestSchema = z.strictObject({
  topic_id: z.string().min(1).max(64),
  run_id: z.string().min(1).max(64).optional(),
  confirm_borderline: z.boolean().optional()
});

export const updateManuscriptRequestSchema = z
  .strictObject({
    selected_title: z.string().trim().min(1).max(120).optional(),
    body_html: z.string().min(1).max(100_000).optional(),
    naver_board_name: z.string().trim().min(1).max(60).optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(30).optional(),
    visibility: visibilitySchema.optional(),
    images: z.array(manuscriptImageRefSchema).max(20).optional(),
    ngram_max_similarity: z.number().min(0).max(1).nullable().optional()
  })
  .superRefine((val, ctx) => {
    if (
      val.selected_title === undefined &&
      val.body_html === undefined &&
      val.naver_board_name === undefined &&
      val.tags === undefined &&
      val.visibility === undefined &&
      val.images === undefined &&
      val.ngram_max_similarity === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '수정할 항목을 하나 이상 입력해 주세요.'
      });
    }
  });

export const resolveVerifyRequestSchema = z
  .strictObject({
    claim_id: z.string().min(1).max(64),
    action: z.enum(['confirm_with_url', 'edit_claim', 'remove_claim']),
    resolution_url: z.url({ error: '유효한 출처 URL(http/https)을 입력해 주세요.' }).optional(),
    updated_claim_text: z.string().trim().min(1).max(500).optional()
  })
  .superRefine((val, ctx) => {
    if (val.action === 'confirm_with_url' && !val.resolution_url) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolution_url'],
        message: '출처 확인 해소 시 확인한 출처 URL이 필수입니다.'
      });
    }
    if (val.action === 'edit_claim' && !val.updated_claim_text) {
      ctx.addIssue({
        code: 'custom',
        path: ['updated_claim_text'],
        message: '문장 수정 해소 시 수정된 문장을 입력해 주세요.'
      });
    }
  });

export const approveManuscriptRequestSchema = z.strictObject({
  content_hash: z.string().length(64),
  ngram_max_similarity: z.number().min(0).max(1).nullable().optional()
});

export const manuscriptSummarySchema = z.strictObject({
  manuscript_id: z.string().min(1).max(64),
  topic_id: z.string().min(1).max(64),
  category_id: z.string().min(1).max(64),
  content_type: contentTypeSchema,
  run_id: z.string().min(1).max(64),
  version: z.number().int().min(1),
  selected_title: z.string().min(1).max(120),
  content_hash: z.string().length(64),
  approved_hash: z.string().length(64).nullable(),
  approved_at: z.iso.datetime().nullable(),
  unresolved_verify_count: z.number().int().min(0),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
});

export const manuscriptSourceExcerptSchema = primarySourceRefSchema.extend({
  excerpt: z.string()
});

export const manuscriptComparisonContextSchema = z.strictObject({
  past_manuscripts: z.array(
    z.strictObject({
      manuscript_id: z.string().min(1),
      selected_title: z.string(),
      body_text: z.string()
    })
  ),
  serp_snippets: z.array(
    z.strictObject({
      id: z.string().min(1),
      label: z.string(),
      text: z.string()
    })
  ),
  sources: z.array(manuscriptSourceExcerptSchema),
  capture_photos: z.array(capturePhotoSchema),
  capture_memo: z.string().nullable()
});

export const manuscriptResponseSchema = z.strictObject({
  manuscript: naverBlogManuscriptBundleSchema,
  unresolved_verify_count: z.number().int().min(0),
  content_type: contentTypeSchema,
  category_id: z.string().min(1).max(64),
  run_id: z.string().min(1).max(64),
  verified: z.boolean().optional(),
  reused_existing: z.boolean().optional()
});

export const manuscriptDetailResponseSchema = z.strictObject({
  manuscript: naverBlogManuscriptBundleSchema,
  unresolved_verify_count: z.number().int().min(0),
  content_type: contentTypeSchema,
  category_id: z.string().min(1).max(64),
  run_id: z.string().min(1).max(64),
  topic: topicDiscoverySchema,
  comparison_context: manuscriptComparisonContextSchema
});

export const manuscriptsListResponseSchema = z.strictObject({
  manuscripts: z.array(manuscriptSummarySchema)
});

export const verifySanitizeResponseSchema = z.strictObject({
  manuscript: naverBlogManuscriptBundleSchema,
  unresolved_verify_count: z.number().int().min(0),
  verified_claim_count: z.number().int().min(0),
  flagged_claim_count: z.number().int().min(0),
  sanitized: z.literal(true)
});

export type GenerateManuscriptRequest = z.infer<typeof generateManuscriptRequestSchema>;
export type UpdateManuscriptRequest = z.infer<typeof updateManuscriptRequestSchema>;
export type ResolveVerifyRequest = z.infer<typeof resolveVerifyRequestSchema>;
export type ApproveManuscriptRequest = z.infer<typeof approveManuscriptRequestSchema>;
export type ManuscriptSummary = z.infer<typeof manuscriptSummarySchema>;
export type ManuscriptComparisonContext = z.infer<typeof manuscriptComparisonContextSchema>;
export type ManuscriptResponse = z.infer<typeof manuscriptResponseSchema>;
export type ManuscriptDetailResponse = z.infer<typeof manuscriptDetailResponseSchema>;
export type ManuscriptsListResponse = z.infer<typeof manuscriptsListResponseSchema>;
export type VerifySanitizeResponse = z.infer<typeof verifySanitizeResponseSchema>;
