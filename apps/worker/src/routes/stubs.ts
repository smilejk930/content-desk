import { Hono } from 'hono';
import type { WorkerEnv } from '../env.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import { requireRecentAuth } from '../middleware/recent-auth.js';
import { AppError } from '../middleware/error-handler.js';

const notImplemented = (phase: string) => () => {
  throw new AppError(501, 'NOT_IMPLEMENTED', `${phase}에서 구현 예정인 엔드포인트입니다.`);
};

export const protectedStubsRoute = new Hono<WorkerEnv>()
  .post('/bridge/tokens', firebaseAuth, requireRecentAuth, notImplemented('Phase 5 (M2)'))
  .delete('/bridge/tokens/:id', firebaseAuth, requireRecentAuth, notImplemented('Phase 5 (M2)'))
  .post('/bridge/jobs', firebaseAuth, requireRecentAuth, notImplemented('Phase 5 (M2)'));
