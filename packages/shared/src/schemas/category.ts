import { z } from '../zod.js';

export const discoveryModeSchema = z.enum(['trend_first', 'experience_first', 'none']);
export const contentTypeSchema = z.enum(['experience_review', 'explainer', 'vlog']);
export const visibilitySchema = z.enum(['전체공개', '이웃공개']);

export const mediaPolicySchema = z.strictObject({
  allowed_content_types: z.array(contentTypeSchema).min(1),
  min_real_photos: z.number().int().min(0).max(20),
  require_field_memo: z.boolean()
});

const categoryProfileBaseSchema = z.strictObject({
  category_id: z.string().min(1).max(64),
  display_name: z.string().min(1).max(60),
  naver_board_name: z.string().min(1).max(60),
  discovery_mode: discoveryModeSchema,
  datalab_anchor_keyword: z.string().min(1).max(50).nullable(),
  seed_keywords: z.array(z.string().min(1).max(50)).max(30),
  primary_source_domains: z.array(z.string().min(1).max(120)).max(50),
  default_media_policy: mediaPolicySchema,
  default_visibility: visibilitySchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
});

function validateCategoryRules(
  val: {
    discovery_mode: z.infer<typeof discoveryModeSchema>;
    datalab_anchor_keyword: string | null;
    primary_source_domains: string[];
    default_media_policy: z.infer<typeof mediaPolicySchema>;
  },
  ctx: z.RefinementCtx
) {
  if (
    (val.discovery_mode === 'trend_first' || val.discovery_mode === 'experience_first') &&
    (!val.datalab_anchor_keyword || val.datalab_anchor_keyword.trim().length === 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['datalab_anchor_keyword'],
      message: 'trend_first 또는 experience_first 모드에서는 datalab_anchor_keyword가 필수입니다.'
    });
  }
  if (
    val.default_media_policy.allowed_content_types.includes('explainer') &&
    val.primary_source_domains.length === 0
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['primary_source_domains'],
      message: 'explainer를 허용하는 카테고리에서는 primary_source_domains가 1개 이상 필요합니다.'
    });
  }
}

export const categoryProfileSchema = categoryProfileBaseSchema.superRefine(validateCategoryRules);

export const createCategoryRequestSchema = categoryProfileBaseSchema
  .omit({
    category_id: true,
    created_at: true,
    updated_at: true
  })
  .superRefine(validateCategoryRules);

export type CategoryProfile = z.infer<typeof categoryProfileSchema>;
export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;
