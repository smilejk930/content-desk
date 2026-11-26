import { z } from '../zod.js';

export const discoveryModeSchema = z.enum(['trend_first', 'experience_first', 'none']);
export const contentTypeSchema = z.enum(['experience_review', 'explainer', 'vlog']);
export const visibilitySchema = z.enum(['전체공개', '이웃공개']);

export type DiscoveryMode = z.infer<typeof discoveryModeSchema>;
export type ContentType = z.infer<typeof contentTypeSchema>;
export type Visibility = z.infer<typeof visibilitySchema>;

/**
 * design_draft.md §2 content_type 허용 조합표:
 * - trend_first: explainer, experience_review
 * - experience_first: experience_review
 * - none (일상/브이로그): vlog
 */
export const ALLOWED_CONTENT_TYPES_BY_DISCOVERY_MODE: Readonly<
  Record<DiscoveryMode, readonly ContentType[]>
> = {
  trend_first: ['explainer', 'experience_review'],
  experience_first: ['experience_review'],
  none: ['vlog']
};

export function isContentTypeAllowedForDiscoveryMode(
  discoveryMode: DiscoveryMode,
  contentType: ContentType
): boolean {
  return ALLOWED_CONTENT_TYPES_BY_DISCOVERY_MODE[discoveryMode].includes(contentType);
}

export const mediaPolicySchema = z.strictObject({
  allowed_content_types: z.array(contentTypeSchema).min(1),
  min_real_photos: z.number().int().min(0).max(20),
  require_field_memo: z.boolean()
});

export type MediaPolicy = z.infer<typeof mediaPolicySchema>;

const categoryProfileBaseSchema = z.strictObject({
  category_id: z.string().min(1).max(64),
  display_name: z.string().trim().min(1).max(60),
  naver_board_name: z.string().trim().min(1).max(60),
  discovery_mode: discoveryModeSchema,
  datalab_anchor_keyword: z.string().trim().min(1).max(50).nullable(),
  seed_keywords: z.array(z.string().trim().min(1).max(50)).max(30),
  primary_source_domains: z.array(z.string().trim().min(1).max(120)).max(50),
  default_media_policy: mediaPolicySchema,
  default_visibility: visibilitySchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
});

function validateCategoryRules(
  val: {
    discovery_mode: DiscoveryMode;
    datalab_anchor_keyword: string | null;
    primary_source_domains: string[];
    default_media_policy: MediaPolicy;
  },
  ctx: z.RefinementCtx
) {
  const allowedForMode = ALLOWED_CONTENT_TYPES_BY_DISCOVERY_MODE[val.discovery_mode];
  const seenTypes = new Set<ContentType>();

  for (const contentType of val.default_media_policy.allowed_content_types) {
    if (seenTypes.has(contentType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default_media_policy', 'allowed_content_types'],
        message: `중복된 콘텐츠 형식(${contentType})이 포함되어 있습니다.`
      });
      break;
    }
    seenTypes.add(contentType);

    if (!allowedForMode.includes(contentType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default_media_policy', 'allowed_content_types'],
        message: `${val.discovery_mode} 모드에서는 ${allowedForMode.join(', ')} 형식만 허용됩니다.`
      });
    }
  }

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
  .extend({
    confirm_borderline: z.boolean().optional()
  })
  .superRefine(validateCategoryRules);

export const updateCategoryRequestSchema = z
  .strictObject({
    display_name: z.string().trim().min(1).max(60).optional(),
    naver_board_name: z.string().trim().min(1).max(60).optional(),
    discovery_mode: discoveryModeSchema.optional(),
    datalab_anchor_keyword: z.string().trim().min(1).max(50).nullable().optional(),
    seed_keywords: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
    primary_source_domains: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    default_media_policy: mediaPolicySchema.optional(),
    default_visibility: visibilitySchema.optional(),
    confirm_borderline: z.boolean().optional()
  })
  .superRefine((val, ctx) => {
    if (
      val.display_name === undefined &&
      val.naver_board_name === undefined &&
      val.discovery_mode === undefined &&
      val.datalab_anchor_keyword === undefined &&
      val.seed_keywords === undefined &&
      val.primary_source_domains === undefined &&
      val.default_media_policy === undefined &&
      val.default_visibility === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '수정할 항목을 하나 이상 입력해 주세요.'
      });
    }
  });

export const categoryResponseSchema = z.strictObject({
  category: categoryProfileSchema
});

export const categoriesListResponseSchema = z.strictObject({
  categories: z.array(categoryProfileSchema)
});

export const deleteCategoryResponseSchema = z.strictObject({
  deleted: z.literal(true),
  category_id: z.string().min(1).max(64)
});

export type CategoryProfile = z.infer<typeof categoryProfileSchema>;
export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
export type CategoryResponse = z.infer<typeof categoryResponseSchema>;
export type CategoriesListResponse = z.infer<typeof categoriesListResponseSchema>;
export type DeleteCategoryResponse = z.infer<typeof deleteCategoryResponseSchema>;
