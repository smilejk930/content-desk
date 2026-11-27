import { z } from '../zod.js';
import { NAVER_BLOG_ID_RE } from '../domain/publish.js';
import { QUOTA_PROVIDERS } from '../domain/quota.js';
import { userRoleSchema } from './admin.js';

const ymdDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'YYYY-MM-DD(KST) 형식이어야 합니다.' });

export const naverBlogIdSchema = z
  .string()
  .trim()
  .regex(NAVER_BLOG_ID_RE, {
    error: '네이버 블로그 ID는 영문, 숫자, 밑줄(_), 하이픈(-)만 사용할 수 있습니다 (최대 50자).'
  });

export const mediaDownloadUrlsRequestSchema = z
  .strictObject({
    manuscript_id: z.string().trim().min(1).max(64).optional(),
    capture_id: z.string().trim().min(1).max(64).optional()
  })
  .superRefine((val, ctx) => {
    const hasManuscript = Boolean(val.manuscript_id);
    const hasCapture = Boolean(val.capture_id);
    if (!hasManuscript && !hasCapture) {
      ctx.addIssue({
        code: 'custom',
        message: 'manuscript_id 또는 capture_id 중 하나를 입력해 주세요.'
      });
    }
    if (hasManuscript && hasCapture) {
      ctx.addIssue({
        code: 'custom',
        message: 'manuscript_id와 capture_id는 동시에 지정할 수 없습니다.'
      });
    }
  });

export const mediaDownloadUrlItemSchema = z.strictObject({
  seq: z.number().int().min(1).max(20),
  r2_key: z.string().min(1),
  caption: z.string(),
  is_ai_generated: z.boolean(),
  download_url: z.url(),
  expires_at: z.iso.datetime()
});

export const mediaDownloadUrlsResponseSchema = z.strictObject({
  expires_in_seconds: z.number().int().positive(),
  items: z.array(mediaDownloadUrlItemSchema)
});

export const registerPublishedPostSchema = z.strictObject({
  manuscript_id: z.string().trim().min(1).max(64),
  post_url: z.url({ error: '유효한 발행 URL(http/https)을 입력해 주세요.' }),
  log_no: z
    .string()
    .trim()
    .regex(/^[0-9]+$/, { error: 'logNo는 숫자만 허용됩니다.' })
    .optional(),
  target_keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(5),
  published_at: z.iso.datetime().optional()
});

export const rankHistoryItemSchema = z.strictObject({
  id: z.string().min(1),
  post_id: z.string().min(1),
  keyword: z.string().min(1),
  rank: z.number().int().min(1).max(100).nullable(),
  checked_date: ymdDateSchema,
  checked_at: z.iso.datetime()
});

export const publishedPostItemSchema = z.strictObject({
  post_id: z.string().min(1),
  manuscript_id: z.string().min(1),
  manuscript_title: z.string(),
  category_id: z.string().min(1),
  category_name: z.string(),
  log_no: z.string().regex(/^[0-9]+$/),
  post_url: z.url(),
  target_keywords: z.array(z.string().min(1)),
  published_at: z.iso.datetime(),
  track_until: ymdDateSchema,
  last_tracked_date: ymdDateSchema.nullable(),
  latest_ranks: z.array(rankHistoryItemSchema),
  rank_history: z.array(rankHistoryItemSchema)
});

export const publishedPostResponseSchema = z.strictObject({
  post: publishedPostItemSchema
});

export const publishedPostsListResponseSchema = z.strictObject({
  posts: z.array(publishedPostItemSchema)
});

export const dailyVisitorRequestSchema = z.strictObject({
  visit_date: ymdDateSchema,
  visitor_count: z.number().int().min(0)
});

export const dailyVisitorItemSchema = z.strictObject({
  visit_date: ymdDateSchema,
  visitor_count: z.number().int().min(0),
  updated_at: z.iso.datetime()
});

export const dailyVisitorResponseSchema = z.strictObject({
  visitor: dailyVisitorItemSchema
});

export const dailyVisitorsListResponseSchema = z.strictObject({
  visitors: z.array(dailyVisitorItemSchema)
});

export const providerQuotaSummarySchema = z.strictObject({
  provider: z.enum(QUOTA_PROVIDERS),
  window_date: z.string().min(1),
  reset_tz: z.enum(['UTC', 'America/Los_Angeles']),
  reset_at: z.iso.datetime(),
  daily_cap: z.number().int().min(0),
  used: z.number().int().min(0),
  reserved: z.number().int().min(0),
  remaining: z.number().int().min(0),
  ratio: z.number().min(0),
  warning: z.boolean(),
  generation_blocked: z.boolean()
});

export const cRankCategoryShareSchema = z.strictObject({
  category_id: z.string().min(1),
  display_name: z.string().min(1),
  count: z.number().int().min(0),
  share: z.number().min(0).max(1)
});

export const dashboardSummaryResponseSchema = z.strictObject({
  kst_today: ymdDateSchema,
  kst_week_start: ymdDateSchema,
  approvals: z.strictObject({
    today_count: z.number().int().min(0),
    week_count: z.number().int().min(0),
    total_approved_count: z.number().int().min(0)
  }),
  c_rank: z.strictObject({
    basis: z.enum(['published_posts', 'approved_manuscripts', 'none']),
    window_days: z.literal(30),
    total_count: z.number().int().min(0),
    category_count: z.number().int().min(0),
    top_category_share: z.number().min(0).max(1),
    warning: z.boolean(),
    warning_reason: z.string().nullable(),
    categories: z.array(cRankCategoryShareSchema)
  }),
  global_quotas: z.array(providerQuotaSummarySchema),
  d1_warning: z.strictObject({
    warning: z.boolean(),
    blocked: z.boolean(),
    reads_ratio: z.number().min(0),
    writes_ratio: z.number().min(0),
    reset_at: z.iso.datetime()
  }),
  r2_usage: z.strictObject({
    used_bytes: z.number().int().min(0),
    limit_bytes: z.number().int().positive(),
    ratio: z.number().min(0),
    warning: z.boolean(),
    source: z.enum(['r2_scan_cache', 'd1_fallback']),
    updated_at: z.iso.datetime().nullable()
  }),
  backup: z.strictObject({
    last_full_export_at: z.iso.datetime().nullable(),
    days_since_export: z.number().int().min(0).nullable(),
    reminder_due: z.boolean()
  }),
  recent_visitors: z.array(dailyVisitorItemSchema),
  published_count: z.number().int().min(0),
  bridge_status: z.strictObject({
    phase: z.literal('M2_PLANNED'),
    status: z.literal('BRIDGE_OFFLINE'),
    message: z.string().min(1)
  })
});

export const updateSettingsRequestSchema = z.strictObject({
  naver_blog_id: naverBlogIdSchema.nullable()
});

export const settingsResponseSchema = z.strictObject({
  naver_blog_id: naverBlogIdSchema.nullable(),
  last_full_export_at: z.iso.datetime().nullable(),
  backup_reminder_due: z.boolean(),
  days_since_export: z.number().int().min(0).nullable()
});

export const meResponseSchema = z.strictObject({
  uid: z.string().min(1),
  email: z.email().nullable(),
  role: userRoleSchema,
  auth_time: z.number().int().positive(),
  session_expires_at: z.iso.datetime(),
  reauth_valid_until: z.iso.datetime(),
  d1_connected: z.boolean()
});

export const exportResponseSchema = z.strictObject({
  exported_at: z.iso.datetime(),
  schema_version: z.literal('1'),
  data: z.strictObject({
    categories: z.array(z.record(z.string(), z.unknown())),
    captures: z.array(z.record(z.string(), z.unknown())),
    topics: z.array(z.record(z.string(), z.unknown())),
    source_snapshots: z.array(z.record(z.string(), z.unknown())),
    manuscripts: z.array(z.record(z.string(), z.unknown())),
    execution_runs: z.array(z.record(z.string(), z.unknown())),
    published_posts: z.array(z.record(z.string(), z.unknown())),
    rank_history: z.array(z.record(z.string(), z.unknown())),
    daily_visitors: z.array(z.record(z.string(), z.unknown())),
    user_meta: z.array(z.record(z.string(), z.unknown()))
  })
});

export type MediaDownloadUrlsRequest = z.infer<typeof mediaDownloadUrlsRequestSchema>;
export type MediaDownloadUrlItem = z.infer<typeof mediaDownloadUrlItemSchema>;
export type MediaDownloadUrlsResponse = z.infer<typeof mediaDownloadUrlsResponseSchema>;
export type RegisterPublishedPostRequest = z.infer<typeof registerPublishedPostSchema>;
export type RankHistoryItem = z.infer<typeof rankHistoryItemSchema>;
export type PublishedPostItem = z.infer<typeof publishedPostItemSchema>;
export type PublishedPostResponse = z.infer<typeof publishedPostResponseSchema>;
export type PublishedPostsListResponse = z.infer<typeof publishedPostsListResponseSchema>;
export type DailyVisitorRequest = z.infer<typeof dailyVisitorRequestSchema>;
export type DailyVisitorItem = z.infer<typeof dailyVisitorItemSchema>;
export type DailyVisitorResponse = z.infer<typeof dailyVisitorResponseSchema>;
export type DailyVisitorsListResponse = z.infer<typeof dailyVisitorsListResponseSchema>;
export type ProviderQuotaSummary = z.infer<typeof providerQuotaSummarySchema>;
export type CRankCategoryShare = z.infer<typeof cRankCategoryShareSchema>;
export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponseSchema>;
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type ExportResponse = z.infer<typeof exportResponseSchema>;
