import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isD1DailyLimitError } from '../src/middleware/error-handler.js';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPairA: TestCertKeyPair;
let keyPairB: TestCertKeyPair;
let keyPairUnknown: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPairA = await generateTestCertKeyPair('kid-a');
  keyPairB = await generateTestCertKeyPair('kid-b');
  keyPairUnknown = await generateTestCertKeyPair('kid-unknown-flood');
});

beforeEach(() => {
  clearFirebaseCertCacheForTests();
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('securetoken@system.gserviceaccount.com')) {
      return new Response(JSON.stringify({ [keyPairA.kid]: keyPairA.certPem }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
      });
    }
    throw new Error(`Unexpected external fetch: ${url}`);
  });
});

describe('Firebase Auth 세션·재인증·시계오차·내보내기·D1 오류 검증', () => {
  it('allows authorized UID on GET /api/me and verifies D1 connectivity', async () => {
    const token = await signFirebaseToken({ keyPair: keyPairA, sub: 'owner-uid-1' });
    const res = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uid: string; d1_connected: boolean };
    expect(body.uid).toBe('owner-uid-1');
    expect(body.d1_connected).toBe(true);
  });

  it('rejects auth_time older than 14 days with 401 SESSION_EXPIRED', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await signFirebaseToken({
      keyPair: keyPairA,
      sub: 'owner-uid-1',
      authTime: nowSec - 1209601
    });
    const res = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_EXPIRED');
  });

  it.each([
    { method: 'POST', path: '/api/export' },
    { method: 'POST', path: '/api/bridge/tokens' },
    { method: 'DELETE', path: '/api/bridge/tokens/tok-1' },
    { method: 'POST', path: '/api/bridge/jobs' }
  ])(
    'rejects auth_time older than 15 minutes on sensitive $method $path with 401 REAUTH_REQUIRED',
    async ({ method, path }) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = await signFirebaseToken({
        keyPair: keyPairA,
        sub: 'owner-uid-1',
        authTime: nowSec - 901
      });
      const res = await SELF.fetch(`https://worker.test${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('REAUTH_REQUIRED');
    }
  );

  it('exports all 11 durable M1 tables (excluding api_cache) and records last_full_export_at', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await signFirebaseToken({
      keyPair: keyPairA,
      sub: 'owner-uid-1',
      authTime: nowSec - 60
    });
    const res = await SELF.fetch('https://worker.test/api/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schema_version: string;
      exported_at: string;
      data: Record<string, Array<Record<string, unknown>>>;
    };
    expect(body.schema_version).toBe('1');
    expect(Object.keys(body.data).sort()).toEqual([
      'app_meta',
      'captures',
      'categories',
      'daily_visitors',
      'execution_runs',
      'manuscripts',
      'published_posts',
      'quota_ledger',
      'rank_history',
      'source_snapshots',
      'topics'
    ]);
    expect(body.data.api_cache).toBeUndefined();
    const metaEntry = body.data.app_meta?.find((m) => m.key === 'last_full_export_at');
    expect(metaEntry?.value).toBe(body.exported_at);
  });

  it('rejects future iat/auth_time beyond 60s skew and wrong aud/iss project', async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    const futureAuthToken = await signFirebaseToken({
      keyPair: keyPairA,
      sub: 'owner-uid-1',
      authTime: nowSec + 120
    });
    const r1 = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${futureAuthToken}` }
    });
    expect(r1.status).toBe(401);

    const wrongProjectToken = await signFirebaseToken({
      keyPair: keyPairA,
      sub: 'owner-uid-1',
      aud: 'other-firebase-project',
      iss: 'https://securetoken.google.com/other-firebase-project'
    });
    const r2 = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${wrongProjectToken}` }
    });
    expect(r2.status).toBe(401);
  });

  it('refetches X.509 certs once on unknown kid rotation and throttles repeated unknown kids within 60s', async () => {
    let callCount = 0;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount += 1;
      const payload =
        callCount === 1
          ? { [keyPairA.kid]: keyPairA.certPem }
          : { [keyPairA.kid]: keyPairA.certPem, [keyPairB.kid]: keyPairB.certPem };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
      });
    });

    const tokenA = await signFirebaseToken({ keyPair: keyPairA, sub: 'owner-uid-1' });
    const r1 = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    expect(r1.status).toBe(200);
    expect(callCount).toBe(1);

    // Rotated valid key triggers single refetch
    const tokenB = await signFirebaseToken({ keyPair: keyPairB, sub: 'owner-uid-1' });
    const r2 = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    expect(r2.status).toBe(200);
    expect(callCount).toBe(2);

    // Repeated unknown kids within 60s cooldown must NOT trigger extra fetches or break valid cache
    const floodToken = await signFirebaseToken({ keyPair: keyPairUnknown, sub: 'owner-uid-1' });
    const r3 = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${floodToken}` }
    });
    const r4 = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${floodToken}` }
    });
    expect(r3.status).toBe(401);
    expect(r4.status).toBe(401);
    expect(callCount).toBe(2);

    // Valid cached key still works without refetching
    const r5 = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    expect(r5.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it('narrowly identifies Cloudflare D1 free-tier daily row limit errors without false positives', () => {
    expect(
      isD1DailyLimitError(new Error("D1_ERROR: exceeded D1's free tier daily row read limit"))
    ).toBe(true);
    expect(
      isD1DailyLimitError(new Error("D1_ERROR: exceeded D1's free tier daily row write limit"))
    ).toBe(true);

    expect(isD1DailyLimitError(new Error('D1_ERROR: near "LIMIT": syntax error'))).toBe(false);
    expect(isD1DailyLimitError(new Error('D1_ERROR: too many SQL variables'))).toBe(false);
    expect(isD1DailyLimitError(new Error('D1_ERROR: CPU time limit exceeded'))).toBe(false);
  });
});
