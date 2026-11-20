import { z } from '../zod.js';

export const sponsorshipSchema = z
  .strictObject({
    is_sponsored: z.boolean(),
    provider_name: z.string().min(1).max(100).optional(),
    compensation_type: z.string().min(1).max(100).optional()
  })
  .superRefine((val, ctx) => {
    if (val.is_sponsored && (!val.provider_name || !val.compensation_type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['is_sponsored'],
        message: '협찬 글은 제공 주체와 제공 형태를 모두 입력해야 합니다.'
      });
    }
  });

export const capturePhotoSchema = z.strictObject({
  seq: z.number().int().min(1).max(20),
  r2_key: z.string().min(1),
  taken_at: z.iso.datetime().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  caption: z.string().max(120)
});

export const capturePresignRequestSchema = z.strictObject({
  capture_id: z.string().min(1).max(64),
  files: z
    .array(
      z.strictObject({
        seq: z.number().int().min(1).max(20),
        content_type: z.enum(['image/webp', 'image/jpeg']),
        byte_size: z.number().int().positive().max(5 * 1024 * 1024)
      })
    )
    .min(1)
    .max(20)
});

export const captureAssetSchema = z.strictObject({
  capture_id: z.string().min(1).max(64),
  category_id: z.string().min(1).max(64),
  content_type: z.enum(['experience_review', 'vlog']),
  photos: z.array(capturePhotoSchema).min(1).max(20),
  field_memo: z.string().max(4000),
  sponsorship: sponsorshipSchema,
  store_location_consent: z.boolean().default(false),
  llm_consent_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime()
});

export const llmConsentRequestSchema = z.strictObject({
  acknowledged_free_tier_training: z.literal(true, {
    error: '무료 LLM 학습 활용 가능성 안내 동의가 필요합니다.'
  })
});

export type CaptureAsset = z.infer<typeof captureAssetSchema>;
export type CapturePresignRequest = z.infer<typeof capturePresignRequestSchema>;
