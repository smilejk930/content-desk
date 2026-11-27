import './zod-init.js';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { parseCsvList, type WorkerBindings, type WorkerEnv } from './env.js';
import { runScheduledTasks } from './jobs/scheduled.js';
import { errorHandler } from './middleware/error-handler.js';
import { adminRoute } from './routes/admin.js';
import { capturesRoute } from './routes/captures.js';
import { categoriesRoute } from './routes/categories.js';
import { exportRoute } from './routes/export.js';
import { manuscriptsRoute } from './routes/manuscripts.js';
import { meRoute } from './routes/me.js';
import { mediaRoute } from './routes/media.js';
import { publishRoute } from './routes/publish.js';
import { protectedStubsRoute } from './routes/stubs.js';
import { topicsRoute } from './routes/topics.js';

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
  .route('/api/admin', adminRoute)
  .route('/api/categories', categoriesRoute)
  .route('/api/captures', capturesRoute)
  .route('/api/topics', topicsRoute)
  .route('/api/manuscripts', manuscriptsRoute)
  .route('/api/media', mediaRoute)
  .route('/api/export', exportRoute)
  .route('/api', publishRoute)
  .route('/api', protectedStubsRoute);

export type AppType = typeof routes;

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: WorkerBindings, _ctx: ExecutionContext) {
    const now = controller.scheduledTime ? new Date(controller.scheduledTime) : new Date();
    await runScheduledTasks(env, now);
  }
};
