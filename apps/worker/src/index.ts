import './zod-init.js';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { parseCsvList, type WorkerBindings, type WorkerEnv } from './env.js';
import { errorHandler } from './middleware/error-handler.js';
import { meRoute } from './routes/me.js';
import { exportRoute } from './routes/export.js';
import { protectedStubsRoute } from './routes/stubs.js';

const app = new Hono<WorkerEnv>();

app.onError(errorHandler);

app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      if (!origin) return '';
      const allowed = parseCsvList((c.env as WorkerBindings).ALLOWED_ORIGINS);
      return allowed.includes(origin) ? origin : '';
    },
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600
  })
);

const routes = app
  .get('/api/health', (c) => c.json({ ok: true, service: 'content-desk-worker' }))
  .route('/api/me', meRoute)
  .route('/api/export', exportRoute)
  .route('/api', protectedStubsRoute);

export type AppType = typeof routes;

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: WorkerBindings, _ctx: ExecutionContext) {
    // Phase 4 (rank tracking) & Phase 5 (M2 job expiry cleanup) scheduled tasks
  }
};
