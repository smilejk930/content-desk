import { z } from '../zod.js';
import { contentTypeSchema } from './category.js';
import { sponsorshipSchema } from './capture.js';

export const topicTrackSchema = z.enum(['category_discovery', 'personal_vlog']);
export const ymylStatusSchema = z.enum(['SAFE', 'BORDERLINE_PENDING', 'BORDERLINE_CONFIRMED', 'BLOCKED']);

export const primarySourceRefSchema = z.strictObject({
  source_id: z.string().min(1).max(64),
  url: z.url(),
  domain: z.string().min(1).max(120),
  r2_key: z.string().min(1),
  fetched_at: z.iso.datetime(),
  body_sha256: z.string().length(64),
  ingest_channel: z.enum(['webkr_search', 'manual_input'])
});

export const topicDiscoverySchema = z
  .strictObject({
    topic_id: z.string().min(1).max(64),
    run_id: z.string().min(1).max(64),
    track: topicTrackSchema,
    category_id: z.string().min(1).max(64),
    content_type: contentTypeSchema,
    keyword: z.string().min(1).max(120),
    capture_ids: z.array(z.string().min(1)).default([]),
    sources: z.array(primarySourceRefSchema).default([]),
    ymyl_status: ymylStatusSchema,
    sponsorship: sponsorshipSchema,
    datalab_demand_index: z.number().min(0).nullable(),
    blog_supply_count: z.number().int().min(0).nullable(),
    news_supply_count: z.number().int().min(0).nullable(),
    monthly_search_volume: z.number().int().min(0).nullable(),
    competition_score: z.number().min(0).nullable(),
    created_at: z.iso.datetime()
  })
  .superRefine((val, ctx) => {
    if (val.track === 'personal_vlog' && val.content_type !== 'vlog') {
      ctx.addIssue({
        code: 'custom',
        path: ['content_type'],
        message: 'personal_vlog 트랙은 vlog 콘텐츠 형식만 허용됩니다.'
      });
    }
    if (val.content_type === 'explainer' && val.sources.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'explainer 글감에는 1차 출처 스냅샷이 1개 이상 필요합니다.'
      });
    }
  });

export type TopicDiscoveryJSON = z.infer<typeof topicDiscoverySchema>;
