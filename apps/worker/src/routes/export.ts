import { Hono } from 'hono';
import type { WorkerEnv } from '../env.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import { requireRecentAuth } from '../middleware/recent-auth.js';
import { exportUserData } from '../repositories/export.repo.js';

export const exportRoute = new Hono<WorkerEnv>().post(
  '/',
  firebaseAuth,
  requireRecentAuth,
  async (c) => {
    const scope = c.get('userScope');
    const nowIso = new Date().toISOString();

    const data = await exportUserData(scope, c.env.DB, nowIso);

    return c.json({
      exported_at: nowIso,
      schema_version: '1' as const,
      data
    });
  }
);
