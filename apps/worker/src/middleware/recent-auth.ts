import { createMiddleware } from 'hono/factory';
import { parsePositiveInt, type WorkerEnv } from '../env.js';
import { AppError } from './error-handler.js';

export const requireRecentAuth = createMiddleware<WorkerEnv>(async (c, next) => {
  const auth = c.get('auth');
  if (!auth) {
    throw new AppError(401, 'TOKEN_INVALID', '인증 정보가 없습니다.');
  }

  const reauthMaxAgeSec = parsePositiveInt(c.env.REAUTH_MAX_AGE_SECONDS, 900);
  const nowSec = Math.floor(Date.now() / 1000);

  if (nowSec - auth.authTime > reauthMaxAgeSec) {
    throw new AppError(
      401,
      'REAUTH_REQUIRED',
      '민감 작업을 수행하려면 최근 15분 이내 Google 재인증이 필요합니다.'
    );
  }

  await next();
});
