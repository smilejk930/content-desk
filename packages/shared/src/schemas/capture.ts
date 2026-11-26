import { z } from '../zod.js';

export const captureIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, { error: 'capture_id는 영문, 숫자, 하이픈(-), 밑줄(_)만 허용됩니다.' });

export const captureContentTypeSchema = z.enum(['experience_review', 'vlog']);
export const captureUploadMimeSchema = z.enum(['image/webp', 'image/jpeg']);

export type CaptureContentType = z.infer<typeof captureContentTypeSchema>;
export type CaptureUploadMime = z.infer<typeof captureUploadMimeSchema>;

export const MAX_CAPTURE_PHOTOS = 20;
export const MAX_CAPTURE_FILE_BYTES = 5 * 1024 * 1024;

export const sponsorshipSchema = z
  .strictObject({
    is_sponsored: z.boolean(),
    provider_name: z.string().trim().min(1).max(100).optional(),
    compensation_type: z.string().trim().min(1).max(100).optional()
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

export type CaptureSponsorship = z.infer<typeof sponsorshipSchema>;

export const capturePhotoSchema = z.strictObject({
  seq: z.number().int().min(1).max(MAX_CAPTURE_PHOTOS),
  r2_key: z.string().min(1).max(512),
  mime_type: captureUploadMimeSchema,
  byte_size: z.number().int().positive().max(MAX_CAPTURE_FILE_BYTES),
  taken_at: z.iso.datetime({ offset: true }).nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  caption: z.string().max(120)
});

export type CapturePhoto = z.infer<typeof capturePhotoSchema>;

export const capturePresignFileSchema = z.strictObject({
  seq: z.number().int().min(1).max(MAX_CAPTURE_PHOTOS),
  content_type: captureUploadMimeSchema,
  byte_size: z.number().int().positive().max(MAX_CAPTURE_FILE_BYTES)
});

export const capturePresignRequestSchema = z
  .strictObject({
    capture_id: captureIdSchema,
    category_id: z.string().min(1).max(64),
    files: z.array(capturePresignFileSchema).min(1).max(MAX_CAPTURE_PHOTOS)
  })
  .superRefine((val, ctx) => {
    const seen = new Set<number>();
    for (const file of val.files) {
      if (seen.has(file.seq)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files'],
          message: `중복된 사진 순번(seq=${file.seq})은 허용되지 않습니다.`
        });
        break;
      }
      seen.add(file.seq);
    }
  });

export const capturePresignUploadSchema = z.strictObject({
  seq: z.number().int().min(1).max(MAX_CAPTURE_PHOTOS),
  r2_key: z.string().min(1).max(512),
  content_type: captureUploadMimeSchema,
  upload_url: z.url(),
  expires_at: z.iso.datetime()
});

export const capturePresignResponseSchema = z.strictObject({
  capture_id: captureIdSchema,
  expires_in_seconds: z.number().int().positive(),
  uploads: z.array(capturePresignUploadSchema).min(1).max(MAX_CAPTURE_PHOTOS)
});

function validateCaptureEvidence(
  val: {
    photos: CapturePhoto[];
    field_memo: string;
  },
  ctx: z.RefinementCtx
) {
  if (val.photos.length === 0 && val.field_memo.trim().length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['field_memo'],
      message: '실사 사진 또는 현장 메모 중 최소 1건 이상 입력해야 합니다.'
    });
  }

  const seen = new Set<number>();
  for (const photo of val.photos) {
    if (seen.has(photo.seq)) {
      ctx.addIssue({
        code: 'custom',
        path: ['photos'],
        message: `중복된 사진 순번(seq=${photo.seq})은 허용되지 않습니다.`
      });
      break;
    }
    seen.add(photo.seq);
  }
}

export const createCaptureRequestSchema = z
  .strictObject({
    capture_id: captureIdSchema.optional(),
    category_id: z.string().min(1).max(64),
    content_type: captureContentTypeSchema,
    photos: z.array(capturePhotoSchema).min(0).max(MAX_CAPTURE_PHOTOS).default([]),
    field_memo: z.string().max(4000).default(''),
    sponsorship: sponsorshipSchema.default({ is_sponsored: false }),
    store_location_consent: z
      .literal(false, {
        error: '위치 정보 저장은 허용되지 않습니다. 위치 정보(EXIF)가 제거된 사진만 등록할 수 있습니다.'
      })
      .default(false)
  })
  .superRefine(validateCaptureEvidence);

export const captureAssetSchema = z
  .strictObject({
    capture_id: captureIdSchema,
    category_id: z.string().min(1).max(64),
    content_type: captureContentTypeSchema,
    photos: z.array(capturePhotoSchema).min(0).max(MAX_CAPTURE_PHOTOS),
    field_memo: z.string().max(4000),
    sponsorship: sponsorshipSchema,
    store_location_consent: z.literal(false).default(false),
    llm_consent_at: z.iso.datetime().nullable(),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime()
  })
  .superRefine(validateCaptureEvidence);

export const llmConsentRequestSchema = z.strictObject({
  acknowledged_free_tier_training: z.literal(true, {
    error: '무료 LLM 학습 활용 가능성 안내 동의가 필요합니다.'
  })
});

export const captureResponseSchema = z.strictObject({
  capture: captureAssetSchema
});

export const capturesListResponseSchema = z.strictObject({
  captures: z.array(captureAssetSchema)
});

export type CaptureAsset = z.infer<typeof captureAssetSchema>;
export type CreateCaptureRequest = z.infer<typeof createCaptureRequestSchema>;
export type CapturePresignRequest = z.infer<typeof capturePresignRequestSchema>;
export type CapturePresignUpload = z.infer<typeof capturePresignUploadSchema>;
export type CapturePresignResponse = z.infer<typeof capturePresignResponseSchema>;
export type LlmConsentRequest = z.infer<typeof llmConsentRequestSchema>;
export type CaptureResponse = z.infer<typeof captureResponseSchema>;
export type CapturesListResponse = z.infer<typeof capturesListResponseSchema>;
