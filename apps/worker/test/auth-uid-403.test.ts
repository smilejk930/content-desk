import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  keyPair = await generateTestCertKeyPair('kid-uid-test');
});

beforeEach(() => {
  clearFirebaseCertCacheForTests();
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

describe('가입 경로 차단 전수 검증 (ALLOWED_UIDS 403)', () => {
  const endpoints: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/api/me' },
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
    'returns 403 UID_NOT_ALLOWED for unauthorized valid Google UID on $method $path',
    async ({ method, path }) => {
      const token = await signFirebaseToken({
        keyPair,
        sub: 'uninvited-google-user-999',
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
      expect(body.error.code).toBe('UID_NOT_ALLOWED');
      expect(body.error.details?.uid).toBe('uninvited-google-user-999');
    }
  );

  it('fails closed with 403 when ALLOWED_UIDS is empty (before Phase 1 UID registration)', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const workerModule = (await import('../src/index.js')).default;
    const res = await workerModule.fetch(
      new Request('https://worker.test/api/me', {
        headers: { Authorization: `Bearer ${token}` }
      }),
      { ...env, ALLOWED_UIDS: '' },
      {} as ExecutionContext
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UID_NOT_ALLOWED');
  });
});
