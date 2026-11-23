import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-access-test');
});

beforeEach(async () => {
  clearFirebaseCertCacheForTests();
  await env.DB.prepare('DELETE FROM users').run();
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('securetoken@system.gserviceaccount.com')) {
      return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=3600'
        }
      });
    }
    throw new Error(`Unexpected external fetch in test: ${url}`);
  });
});

describe('가입 경로 차단 및 사용자 상태 전수 검증 (ADMIN_UIDS / D1 users)', () => {
  const endpoints: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/api/me' },
    { method: 'GET', path: '/api/admin/users' },
    { method: 'POST', path: '/api/admin/users' },
    { method: 'PATCH', path: '/api/admin/users/some-user-1' },
    { method: 'GET', path: '/api/categories' },
    { method: 'POST', path: '/api/categories' },
    { method: 'POST', path: '/api/captures/presign' },
    { method: 'POST', path: '/api/manuscripts/m1/approve' },
    { method: 'POST', path: '/api/media/download-urls' },
    { method: 'POST', path: '/api/export' },
    { method: 'POST', path: '/api/bridge/tokens' },
    { method: 'DELETE', path: '/api/bridge/tokens/t1' },
    { method: 'POST', path: '/api/bridge/jobs' }
  ];

  it.each(endpoints)(
    'returns 403 USER_NOT_REGISTERED with details.uid for unregistered Google UID on $method $path',
    async ({ method, path }) => {
      const token = await signFirebaseToken({
        keyPair,
        sub: 'unregistered-google-user-999',
        email: 'stranger@gmail.com'
      });

      const res = await SELF.fetch(`https://worker.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; details?: { uid?: string } } };
      expect(body.error.code).toBe('USER_NOT_REGISTERED');
      expect(body.error.details?.uid).toBe('unregistered-google-user-999');
    }
  );

  it('allows active registered user and immediately blocks on next request with same token when status becomes blocked', async () => {
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`
    )
      .bind('user-active-1', '테스터 A', 'owner-uid-1', nowIso, nowIso, nowIso)
      .run();

    const token = await signFirebaseToken({
      keyPair,
      sub: 'user-active-1',
      email: 'user-a@example.com'
    });

    const first = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { uid: string; role: string };
    expect(firstBody.uid).toBe('user-active-1');
    expect(firstBody.role).toBe('user');

    // Block in D1 directly: must take effect immediately on the very next request (no memory cache)
    await env.DB.prepare(`UPDATE users SET status = 'blocked' WHERE uid = ?`)
      .bind('user-active-1')
      .run();

    const second = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(second.status).toBe(403);
    const secondBody = (await second.json()) as { error: { code: string } };
    expect(secondBody.error.code).toBe('USER_BLOCKED');
  });

  it('allows ADMIN_UIDS user without any row in D1 users table and returns role=admin', async () => {
    const countRow = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM users').first<{ cnt: number }>();
    expect(countRow?.cnt).toBe(0);

    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const res = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { uid: string; role: string };
    expect(body.uid).toBe('owner-uid-1');
    expect(body.role).toBe('admin');
  });

  it('fails closed with 403 USER_NOT_REGISTERED for everyone when both ADMIN_UIDS and users are empty', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const workerModule = (await import('../src/index.js')).default;
    const res = await workerModule.fetch(
      new Request('https://worker.test/api/me', {
        headers: { Authorization: `Bearer ${token}` }
      }),
      { ...env, ADMIN_UIDS: '' },
      {} as ExecutionContext
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details?: { uid?: string } } };
    expect(body.error.code).toBe('USER_NOT_REGISTERED');
    expect(body.error.details?.uid).toBe('owner-uid-1');
  });
});
