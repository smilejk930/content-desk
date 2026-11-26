import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminUsersListResponseSchema } from '@content-desk/shared';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { getPacificDateString, getUtcDateString } from '../src/repositories/users.repo.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-admin-test');
});

beforeEach(async () => {
  clearFirebaseCertCacheForTests();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM usage_daily'),
    env.DB.prepare('DELETE FROM categories'),
    env.DB.prepare('DELETE FROM users')
  ]);
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('securetoken@system.gserviceaccount.com')) {
      return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
      });
    }
    throw new Error(`Unexpected external fetch: ${url}`);
  });
});

describe('관리자 사용자 관리 API (/api/admin/users*)', () => {
  it('returns 403 ADMIN_ONLY when a registered non-admin user calls any /api/admin/users* endpoint', async () => {
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`
    )
      .bind('normal-user-1', '일반 사용자', 'owner-uid-1', nowIso, nowIso, nowIso)
      .run();

    const userToken = await signFirebaseToken({ keyPair, sub: 'normal-user-1' });

    const rGet = await SELF.fetch('https://worker.test/api/admin/users', {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    expect(rGet.status).toBe(403);
    expect(((await rGet.json()) as { error: { code: string } }).error.code).toBe('ADMIN_ONLY');

    const rPost = await SELF.fetch('https://worker.test/api/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'new-user-1', label: '신규' })
    });
    expect(rPost.status).toBe(403);
    expect(((await rPost.json()) as { error: { code: string } }).error.code).toBe('ADMIN_ONLY');

    const rPatch = await SELF.fetch('https://worker.test/api/admin/users/normal-user-1', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'blocked' })
    });
    expect(rPatch.status).toBe(403);
    expect(((await rPatch.json()) as { error: { code: string } }).error.code).toBe('ADMIN_ONLY');
  });

  it('requires 15-minute recent auth on GET/POST/PATCH /api/admin/users*', async () => {
    const staleAuthSec = Math.floor(Date.now() / 1000) - 901;
    const staleAdminToken = await signFirebaseToken({
      keyPair,
      sub: 'owner-uid-1',
      authTime: staleAuthSec
    });

    for (const req of [
      { method: 'GET', path: '/api/admin/users' },
      { method: 'POST', path: '/api/admin/users', body: JSON.stringify({ uid: 'user-new-1', label: 'A' }) },
      { method: 'PATCH', path: '/api/admin/users/user-new-1', body: JSON.stringify({ status: 'blocked' }) }
    ]) {
      const res = await SELF.fetch(`https://worker.test${req.path}`, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${staleAdminToken}`,
          'Content-Type': 'application/json'
        },
        body: req.body
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REAUTH_REQUIRED');
    }
  });

  it('validates UID format (400), rejects duplicates (409), rejects blocking/modifying ADMIN_UIDS (400), and returns 404 for unknown UID', async () => {
    const adminToken = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });

    // Invalid UID format -> 400
    const badUid = await SELF.fetch('https://worker.test/api/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'bad uid!', label: '잘못된 UID' })
    });
    expect(badUid.status).toBe(400);
    expect(((await badUid.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    // Duplicate of ADMIN_UIDS -> 409
    const dupAdmin = await SELF.fetch('https://worker.test/api/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'owner-uid-1', label: '중복 관리자' })
    });
    expect(dupAdmin.status).toBe(409);
    expect(((await dupAdmin.json()) as { error: { code: string } }).error.code).toBe('USER_ALREADY_EXISTS');

    // Valid creation -> 201
    const created = await SELF.fetch('https://worker.test/api/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'user-dup-check-1', label: '테스터' })
    });
    expect(created.status).toBe(201);

    // Duplicate of existing users row -> 409
    const dupUser = await SELF.fetch('https://worker.test/api/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'user-dup-check-1', label: '중복 사용자' })
    });
    expect(dupUser.status).toBe(409);
    expect(((await dupUser.json()) as { error: { code: string } }).error.code).toBe('USER_ALREADY_EXISTS');

    // Blocking ADMIN_UIDS -> 400
    const blockAdmin = await SELF.fetch('https://worker.test/api/admin/users/owner-uid-1', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'blocked' })
    });
    expect(blockAdmin.status).toBe(400);
    expect(((await blockAdmin.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    // Non-existent user -> 404
    const notFound = await SELF.fetch('https://worker.test/api/admin/users/nonexistent-uid-99', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '없음' })
    });
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('registers, blocks, unblocks, and updates label with immediate effect on user access', async () => {
    const adminToken = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const targetUid = 'member-lifecycle-1';
    const userToken = await signFirebaseToken({ keyPair, sub: targetUid });

    // Before registration -> 403 USER_NOT_REGISTERED
    const beforeReg = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    expect(beforeReg.status).toBe(403);
    expect(((await beforeReg.json()) as { error: { code: string } }).error.code).toBe('USER_NOT_REGISTERED');

    // Register -> 201
    const regRes = await SELF.fetch('https://worker.test/api/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: targetUid, label: '초기 라벨' })
    });
    expect(regRes.status).toBe(201);

    // Immediately allowed -> 200
    const afterReg = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    expect(afterReg.status).toBe(200);

    // Block -> 200 and immediately reflected as 403 USER_BLOCKED
    const blockRes = await SELF.fetch(`https://worker.test/api/admin/users/${targetUid}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'blocked', label: '차단된 사용자' })
    });
    expect(blockRes.status).toBe(200);
    const blockBody = (await blockRes.json()) as { user: { label: string; status: string } };
    expect(blockBody.user.label).toBe('차단된 사용자');
    expect(blockBody.user.status).toBe('blocked');

    const whileBlocked = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    expect(whileBlocked.status).toBe(403);
    expect(((await whileBlocked.json()) as { error: { code: string } }).error.code).toBe('USER_BLOCKED');

    // Unblock -> 200 and immediately allowed again
    const unblockRes = await SELF.fetch(`https://worker.test/api/admin/users/${targetUid}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' })
    });
    expect(unblockRes.status).toBe(200);

    const afterUnblock = await SELF.fetch('https://worker.test/api/me', {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    expect(afterUnblock.status).toBe(200);
  });

  it('merges ADMIN_UIDS with users rows, returns today usage_daily numeric counts only, and exposes zero user content', async () => {
    const adminToken = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const now = new Date();
    const nowIso = now.toISOString();
    const utcToday = getUtcDateString(now);
    const pacificToday = getPacificDateString(now);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?)`
      ).bind('user-usage-1', '사용자 A', 'owner-uid-1', nowIso, nowIso, nowIso),
      // Today's numeric usage counts using provider-specific window_date (UTC for naver, Pacific for gemini*)
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls) VALUES (?, ?, ?, ?)`
      ).bind('owner-uid-1', 'naver_search', utcToday, 7),
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls) VALUES (?, ?, ?, ?)`
      ).bind('user-usage-1', 'naver_search', utcToday, 15),
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls) VALUES (?, ?, ?, ?)`
      ).bind('user-usage-1', 'gemini_text', pacificToday, 4),
      // Old date usage must NOT be counted in todayUsage
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls) VALUES (?, ?, ?, ?)`
      ).bind('user-usage-1', 'gemini_text', '2020-01-01', 99),
      // Private content row that must NEVER leak into admin list response
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES (?, ?, ?, 'trend_first', '비밀키워드', '전체공개', ?, ?, ?)`
      ).bind(
        'cat-secret-1',
        'user-usage-1',
        '비밀카테고리',
        JSON.stringify({ secretMemo: 'TOP_SECRET_USER_CONTENT' }),
        nowIso,
        nowIso
      )
    ]);

    const res = await SELF.fetch('https://worker.test/api/admin/users', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(res.status).toBe(200);
    const rawText = await res.text();
    expect(rawText).not.toContain('TOP_SECRET_USER_CONTENT');
    expect(rawText).not.toContain('비밀카테고리');
    expect(rawText).not.toContain('비밀키워드');

    const parsed = adminUsersListResponseSchema.safeParse(JSON.parse(rawText));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.windowDate).toBe(utcToday);
    const adminRow = parsed.data.users.find((u) => u.uid === 'owner-uid-1');
    const userRow = parsed.data.users.find((u) => u.uid === 'user-usage-1');

    expect(adminRow).toBeDefined();
    expect(adminRow?.role).toBe('admin');
    expect(adminRow?.status).toBe('active');
    expect(adminRow?.todayUsage.totalCalls).toBe(7);
    expect(adminRow?.todayUsage.byProvider).toEqual({ naver_search: 7 });

    expect(userRow).toBeDefined();
    expect(userRow?.role).toBe('user');
    expect(userRow?.todayUsage.totalCalls).toBe(19);
    expect(userRow?.todayUsage.byProvider).toEqual({ naver_search: 15, gemini_text: 4 });
  });

  it('aggregates gemini_text/gemini_image by America/Los_Angeles date and other providers by UTC date using shared mapping table', async () => {
    // Pick tomorrow 03:00:00Z so UTC date is (D+1) while America/Los_Angeles is still (D),
    // and timestamp remains well within the 30-day test X.509 cert validity window.
    const realNow = new Date();
    const splitUtc = new Date(
      Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth(), realNow.getUTCDate() + 1, 3, 0, 0)
    );
    const expectedUtcDate = getUtcDateString(splitUtc);
    const expectedPacificDate = getPacificDateString(splitUtc);
    expect(expectedUtcDate).not.toBe(expectedPacificDate);

    vi.useFakeTimers({ toFake: ['Date'], now: splitUtc });
    try {
      const adminToken = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
      const nowIso = splitUtc.toISOString();

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
           VALUES (?, ?, 'active', ?, ?, ?, ?)`
        ).bind('user-tz-1', '시간대 테스터', 'owner-uid-1', nowIso, nowIso, nowIso),
        // Active UTC window for naver_search -> counted
        env.DB.prepare(
          `INSERT INTO usage_daily (owner_uid, provider, window_date, calls) VALUES (?, ?, ?, ?)`
        ).bind('user-tz-1', 'naver_search', expectedUtcDate, 11),
        // Previous UTC day for naver_search -> NOT counted
        env.DB.prepare(
          `INSERT INTO usage_daily (owner_uid, provider, window_date, calls) VALUES (?, ?, ?, ?)`
        ).bind('user-tz-1', 'naver_search', expectedPacificDate, 99),
        // Active America/Los_Angeles window for gemini_text / gemini_image -> counted
        env.DB.prepare(
          `INSERT INTO usage_daily (owner_uid, provider, window_date, calls) VALUES (?, ?, ?, ?)`
        ).bind('user-tz-1', 'gemini_text', expectedPacificDate, 6),
        env.DB.prepare(
          `INSERT INTO usage_daily (owner_uid, provider, window_date, calls) VALUES (?, ?, ?, ?)`
        ).bind('user-tz-1', 'gemini_image', expectedPacificDate, 4),
        // Next Pacific day (= UTC date) for gemini_text -> NOT counted
        env.DB.prepare(
          `INSERT INTO usage_daily (owner_uid, provider, window_date, calls) VALUES (?, ?, ?, ?)`
        ).bind('user-tz-1', 'gemini_text', expectedUtcDate, 88)
      ]);

      const res = await SELF.fetch('https://worker.test/api/admin/users', {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(res.status).toBe(200);
      const parsed = adminUsersListResponseSchema.parse(await res.json());

      expect(parsed.windowDate).toBe(expectedUtcDate);
      const tzUser = parsed.users.find((u) => u.uid === 'user-tz-1');
      expect(tzUser).toBeDefined();
      expect(tzUser?.todayUsage.totalCalls).toBe(21);
      expect(tzUser?.todayUsage.byProvider).toEqual({
        naver_search: 11,
        gemini_text: 6,
        gemini_image: 4
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
