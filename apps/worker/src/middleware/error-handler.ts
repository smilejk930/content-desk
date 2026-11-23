import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiErrorCode } from '@content-desk/shared';
import type { WorkerEnv } from '../env.js';

export class AppError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly resetAt?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: ContentfulStatusCode,
    code: ApiErrorCode,
    message: string,
    options?: { resetAt?: string; details?: Record<string, unknown> }
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.resetAt = options?.resetAt;
    this.details = options?.details;
  }
}

export function getNextUtcMidnightIso(nowMs = Date.now()): string {
  const now = new Date(nowMs);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return new Date(next).toISOString();
}

const D1_DAILY_LIMIT_PATTERNS = [
  /exceeded\s+d1'?s?\s+free\s+tier\s+daily\s+row\s+(?:read|write)\s+limit/i,
  /d1[_\s-]?error[\s\S]*daily\s+row\s+(?:read|write)\s+limit/i
];

export function isD1DailyLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return D1_DAILY_LIMIT_PATTERNS.some((re) => re.test(msg));
}

export function errorHandler(err: Error, c: Context<WorkerEnv>): Response {
  if (err instanceof AppError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.resetAt ? { reset_at: err.resetAt } : {}),
          ...(err.details ? { details: err.details } : {})
        }
      },
      err.status
    );
  }

  if (err instanceof HTTPException && err.status === 400) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR' as ApiErrorCode,
          message: '요청 형식이 올바르지 않습니다.'
        }
      },
      400
    );
  }

  if (isD1DailyLimitError(err)) {
    return c.json(
      {
        error: {
          code: 'D1_DAILY_LIMIT_EXCEEDED' as ApiErrorCode,
          message: 'Cloudflare D1 무료 일일 한도에 도달했습니다. 다음 UTC 자정 이후 다시 시도해 주세요.',
          reset_at: getNextUtcMidnightIso()
        }
      },
      503
    );
  }

  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR' as ApiErrorCode,
        message: '요청 처리 중 내부 오류가 발생했습니다.'
      }
    },
    500
  );
}
