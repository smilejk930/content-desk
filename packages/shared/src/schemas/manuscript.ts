import { z } from '../zod.js';
import { visibilitySchema } from './category.js';
import { sponsorshipSchema } from './capture.js';

export const manuscriptClaimSchema = z.strictObject({
  claim_id: z.string().min(1),
  claim: z.string().min(1),
  source_id: z.string().min(1).nullable(),
  quote: z.string().nullable(),
  verification_status: z.enum(['VERIFIED', 'VERIFY_REQUIRED', 'RESOLVED_BY_OWNER']),
  resolution_url: z.url().nullable()
});

export const manuscriptImageRefSchema = z.strictObject({
  seq: z.number().int().min(1).max(20),
  r2_key: z.string().min(1),
  caption: z.string().min(1).max(120),
  is_ai_generated: z.boolean()
});

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
  approved_hash: z.string().length(64).nullable(),
  approved_at: z.iso.datetime().nullable()
});

export const approveManuscriptRequestSchema = z.strictObject({
  content_hash: z.string().length(64)
});

export type NaverBlogManuscriptBundle = z.infer<typeof naverBlogManuscriptBundleSchema>;
