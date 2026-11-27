import { Hono } from 'hono';
import { sValidator } from '@hono/standard-validator';
import { mediaDownloadUrlsRequestSchema } from '@content-desk/shared';
import type { WorkerEnv } from '../env.js';
import { AppError } from '../middleware/error-handler.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import { getCaptureById } from '../repositories/captures.repo.js';
import { getManuscriptById } from '../repositories/manuscripts.repo.js';
import {
  assertOwnerObjectKey,
  presignR2GetUrl,
  R2_GET_EXPIRES_SECONDS,
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

export const mediaRoute = new Hono<WorkerEnv>().post(
  '/download-urls',
  firebaseAuth,
  sValidator('json', mediaDownloadUrlsRequestSchema, (result) => {
    if (!result.success) throwValidationError(result.error);
  }),
  async (c) => {
    const scope = c.get('userScope');
    const body = c.req.valid('json');

    let targets: Array<{
      seq: number;
      r2_key: string;
      caption: string;
      is_ai_generated: boolean;
    }>;

    if (body.manuscript_id) {
      const record = await getManuscriptById(scope, c.env.DB, body.manuscript_id);
      if (!record) {
        throw new AppError(404, 'NOT_FOUND', '대상 원고를 찾을 수 없습니다.');
      }
      targets = [...record.manuscript.images]
        .sort((a, b) => a.seq - b.seq)
        .map((img) => ({
          seq: img.seq,
          r2_key: img.r2_key,
          caption: img.caption,
          is_ai_generated: img.is_ai_generated
        }));
    } else {
      const capture = await getCaptureById(scope, c.env.DB, body.capture_id!);
      if (!capture) {
        throw new AppError(404, 'NOT_FOUND', '대상 캡처 자산을 찾을 수 없습니다.');
      }
      targets = [...capture.photos]
        .sort((a, b) => a.seq - b.seq)
        .map((photo) => ({
          seq: photo.seq,
          r2_key: photo.r2_key,
          caption: photo.caption,
          is_ai_generated: false
        }));
    }

    // 소유권 검증(404) 이후 서명 설정(R2_ACCOUNT_ID 및 서명 키) 검증 (미설정 시 503)
    const config = resolveR2SignerConfig(c.env);
    const now = new Date();

    const items = await Promise.all(
      targets.map(async (target) => {
        assertOwnerObjectKey(scope, target.r2_key);
        const signed = await presignR2GetUrl(scope, config, {
          objectKey: target.r2_key,
          expiresInSeconds: R2_GET_EXPIRES_SECONDS,
          now
        });
        return {
          seq: target.seq,
          r2_key: target.r2_key,
          caption: target.caption,
          is_ai_generated: target.is_ai_generated,
          download_url: signed.url,
          expires_at: signed.expiresAt
        };
      })
    );

    return c.json(
      {
        expires_in_seconds: R2_GET_EXPIRES_SECONDS,
        items
      },
      200
    );
  }
);
