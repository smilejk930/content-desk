import { z } from '../zod.js';

export const registerPublishedPostSchema = z.strictObject({
  manuscript_id: z.string().min(1).max(64),
  post_url: z.url(),
  log_no: z.string().regex(/^[0-9]+$/, { error: 'logNo는 숫자만 허용됩니다.' }),
  target_keywords: z.array(z.string().min(1).max(50)).min(1).max(5),
  published_at: z.iso.datetime()
});

export const dailyVisitorRequestSchema = z.strictObject({
  visit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'YYYY-MM-DD(KST) 형식이어야 합니다.' }),
  visitor_count: z.number().int().min(0)
});

export const meResponseSchema = z.strictObject({
  uid: z.string().min(1),
  email: z.email().nullable(),
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
    quota_ledger: z.array(z.record(z.string(), z.unknown())),
    published_posts: z.array(z.record(z.string(), z.unknown())),
    rank_history: z.array(z.record(z.string(), z.unknown())),
    daily_visitors: z.array(z.record(z.string(), z.unknown())),
    app_meta: z.array(z.record(z.string(), z.unknown()))
  })
});

export type MeResponse = z.infer<typeof meResponseSchema>;
export type ExportResponse = z.infer<typeof exportResponseSchema>;
