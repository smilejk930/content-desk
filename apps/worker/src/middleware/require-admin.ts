import { createMiddleware } from 'hono/factory';
import type { WorkerEnv } from '../env.js';
import { AppError } from './error-handler.js';

export const requireAdmin = createMiddleware<WorkerEnv>(async (c, next) => {
  const auth = c.get('auth');
  if (!auth || auth.role !== 'admin') {
    throw new AppError(403, 'ADMIN_ONLY', '관리자만 접근할 수 있는 기능입니다.');
  }

  await next();
});
