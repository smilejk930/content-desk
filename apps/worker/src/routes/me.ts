import { Hono } from 'hono';
import { parsePositiveInt, type WorkerEnv } from '../env.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';

export const meRoute = new Hono<WorkerEnv>().get('/', firebaseAuth, async (c) => {
  const auth = c.get('auth');
  const sessionMaxAgeSec = parsePositiveInt(c.env.SESSION_MAX_AGE_SECONDS, 1209600);
  const reauthMaxAgeSec = parsePositiveInt(c.env.REAUTH_MAX_AGE_SECONDS, 900);

  let d1Connected = false;
  try {
    const ping = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    d1Connected = ping?.ok === 1;
  } catch {
    d1Connected = false;
  }

  return c.json({
    uid: auth.uid,
    email: auth.email,
    auth_time: auth.authTime,
    session_expires_at: new Date((auth.authTime + sessionMaxAgeSec) * 1000).toISOString(),
    reauth_valid_until: new Date((auth.authTime + reauthMaxAgeSec) * 1000).toISOString(),
    d1_connected: d1Connected
  });
});
