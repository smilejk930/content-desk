import { Hono } from 'hono';
import { sValidator } from '@hono/standard-validator';
import {
  capturePresignRequestSchema,
  createCaptureRequestSchema,
  llmConsentRequestSchema,
  MAX_CAPTURE_FILE_BYTES,
  type CaptureAsset
} from '@content-desk/shared';
import type { WorkerEnv } from '../env.js';
import { AppError } from '../middleware/error-handler.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import { getCategoryById } from '../repositories/categories.repo.js';
import {
  createCapture,
  getCaptureById,
  listCaptures,
  recordCaptureLlmConsent
} from '../repositories/captures.repo.js';
import {
  assertOwnerObjectKey,
  buildCaptureObjectKey,
  presignR2PutUrl,
  R2_PUT_EXPIRES_SECONDS,
  resolveR2SignerConfig
} from '../services/r2-signer.js';

function throwValidationError(
  issues: readonly { message: string; path?: readonly unknown[] }[]
): never {
  const firstMessage = issues[0]?.message ?? '요청 값이 올바르지 않습니다.';
  throw new AppError(400, 'VALIDATION_ERROR', firstMessage, {
    details: {
      issues: issues.map((issue) => ({
        message: issue.message,
        path: issue.path
      }))
    }
  });
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

function isForeignKeyConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /FOREIGN KEY constraint failed/i.test(msg);
}

export const capturesRoute = new Hono<WorkerEnv>()
  .post(
    '/presign',
    firebaseAuth,
    sValidator('json', capturePresignRequestSchema, (result) => {
      if (!result.success) {
        throwValidationError(result.error);
      }
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');

      // 1) Verify caller owns the target category before signing any R2 URL
      const category = await getCategoryById(scope, c.env.DB, body.category_id);
      if (!category) {
        throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
      }

      const supportsCapture = category.default_media_policy.allowed_content_types.some(
        (ct) => ct === 'experience_review' || ct === 'vlog'
      );
      if (!supportsCapture) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          '선택한 카테고리는 사진·메모 캡처(experience_review, vlog)를 허용하지 않습니다.'
        );
      }

      const config = resolveR2SignerConfig(c.env);
      const now = new Date();
      const uploads = await Promise.all(
        body.files.map(async (file) => {
          const objectKey = buildCaptureObjectKey(
            scope,
            body.capture_id,
            file.seq,
            file.content_type
          );
          const signed = await presignR2PutUrl(scope, config, {
            objectKey,
            contentType: file.content_type,
            byteSize: file.byte_size,
            now
          });
          return {
            seq: file.seq,
            r2_key: signed.objectKey,
            content_type: file.content_type,
            upload_url: signed.url,
            expires_at: signed.expiresAt
          };
        })
      );

      return c.json(
        {
          capture_id: body.capture_id,
          expires_in_seconds: R2_PUT_EXPIRES_SECONDS,
          uploads
        },
        200
      );
    }
  )
  .get('/', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const categoryId = c.req.query('category_id')?.trim() || undefined;
    const captures = await listCaptures(scope, c.env.DB, { categoryId });
    return c.json({ captures }, 200);
  })
  .post(
    '/',
    firebaseAuth,
    sValidator('json', createCaptureRequestSchema, (result) => {
      if (!result.success) {
        throwValidationError(result.error);
      }
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');

      // 1) Verify caller owns the target category (+ D1 composite FK secondary guard)
      const category = await getCategoryById(scope, c.env.DB, body.category_id);
      if (!category) {
        throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
      }

      if (!category.default_media_policy.allowed_content_types.includes(body.content_type)) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          `선택한 카테고리(${category.display_name})에서는 ${body.content_type} 형식을 허용하지 않습니다.`
        );
      }

      const captureId = body.capture_id ?? crypto.randomUUID();

      // 2) Server-side exact key rebuild & R2 HEAD validation (existence, size <= 5MB & byte_size, MIME)
      for (const photo of body.photos) {
        assertOwnerObjectKey(scope, photo.r2_key, `captures/${captureId}/`);
        const expectedKey = buildCaptureObjectKey(scope, captureId, photo.seq, photo.mime_type);
        if (photo.r2_key !== expectedKey) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            `사진 순번(${photo.seq}) 및 형식(${photo.mime_type})과 일치하지 않는 R2 객체 키입니다.`
          );
        }

        const head = await c.env.MEDIA_BUCKET.head(expectedKey);
        if (!head) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            `R2에 업로드된 사진 객체(seq=${photo.seq})를 찾을 수 없습니다.`
          );
        }

        const actualMime = head.httpMetadata?.contentType ?? '';
        const isAllowedMime = actualMime === 'image/webp' || actualMime === 'image/jpeg';
        const isValidSize =
          head.size > 0 && head.size <= MAX_CAPTURE_FILE_BYTES && head.size === photo.byte_size;

        if (!isValidSize || !isAllowedMime || actualMime !== photo.mime_type) {
          await c.env.MEDIA_BUCKET.delete(expectedKey);
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            `업로드된 사진(seq=${photo.seq})의 크기 또는 MIME 형식이 허용 기준과 일치하지 않아 객체를 삭제했습니다.`
          );
        }
      }

      const nowIso = new Date().toISOString();
      const capture: CaptureAsset = {
        capture_id: captureId,
        category_id: body.category_id,
        content_type: body.content_type,
        photos: body.photos,
        field_memo: body.field_memo,
        sponsorship: body.sponsorship,
        store_location_consent: false,
        llm_consent_at: null,
        created_at: nowIso,
        updated_at: nowIso
      };

      try {
        const created = await createCapture(scope, c.env.DB, capture);
        return c.json({ capture: created }, 201);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          throw new AppError(409, 'CONFLICT', '이미 동일한 capture_id가 존재합니다.');
        }
        if (isForeignKeyConstraintError(err)) {
          throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
        }
        throw err;
      }
    }
  )
  .get('/:id', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const captureId = c.req.param('id');
    const capture = await getCaptureById(scope, c.env.DB, captureId);
    if (!capture) {
      throw new AppError(404, 'NOT_FOUND', '캡처 자산을 찾을 수 없습니다.');
    }
    return c.json({ capture }, 200);
  })
  .post(
    '/:id/consent',
    firebaseAuth,
    sValidator('json', llmConsentRequestSchema, (result) => {
      if (!result.success) {
        throwValidationError(result.error);
      }
    }),
    async (c) => {
      const scope = c.get('userScope');
      const captureId = c.req.param('id');
      const nowIso = new Date().toISOString();
      const updated = await recordCaptureLlmConsent(scope, c.env.DB, captureId, nowIso);
      if (!updated) {
        throw new AppError(404, 'NOT_FOUND', '캡처 자산을 찾을 수 없습니다.');
      }
      return c.json({ capture: updated }, 200);
    }
  );
