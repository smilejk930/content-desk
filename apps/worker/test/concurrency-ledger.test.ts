import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderDailyCap,
  getProviderWindowDate,
  getUtcDateString
} from '@content-desk/shared';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import {
  checkD1BudgetForNewGeneration,
  getGlobalQuotaSummary,
  reserveProviderQuota,
  settleSingleProviderQuota
} from '../src/services/quota-ledger.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-ledger-test');
});

beforeEach(async () => {
  clearFirebaseCertCacheForTests();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM manuscripts'),
    env.DB.prepare('DELETE FROM source_snapshots'),
    env.DB.prepare('DELETE FROM topics'),
    env.DB.prepare('DELETE FROM captures'),
    env.DB.prepare('DELETE FROM categories'),
    env.DB.prepare('DELETE FROM execution_runs'),
    env.DB.prepare('DELETE FROM usage_daily'),
    env.DB.prepare('DELETE FROM quota_ledger'),
    env.DB.prepare('DELETE FROM api_cache'),
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
    if (url.includes('generativelanguage.googleapis.com')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      verdict: 'SAFE',
                      reason: '비YMYL',
                      title_candidates: ['D1 테스트 원고'],
                      selected_title: 'D1 테스트 원고',
                      body_html: '<p>D1은 서버리스 SQLite 데이터베이스입니다.</p>',
                      tags: ['D1'],
                      claims: []
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected fetch in concurrency-ledger.test: ${url}`);
  });
});

describe('할당량 원장 원자 예약·정산 · usage_daily · D1 보수 상한 · run_id 멱등성', () => {
  it('enforces atomic SQL reservation under concurrency and leaves usage_daily untouched on reservation failure', async () => {
    const now = new Date();
    const pacificDate = getProviderWindowDate('gemini_text', now);

    // Seed gemini_text with daily_cap=3 so only 3 concurrent reservations can succeed out of 6
    await env.DB.prepare(
      `INSERT INTO quota_ledger (provider, window_date, reset_tz, daily_cap, used, reserved, updated_at)
       VALUES ('gemini_text', ?, 'America/Los_Angeles', 3, 0, 0, ?)`
    )
      .bind(pacificDate, now.toISOString())
      .run();

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        reserveProviderQuota(env.DB, {
          provider: 'gemini_text',
          amount: 1,
          now,
          dailyCapOverride: 3
        })
      )
    );

    const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
    const rejected = attempts.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(3);

    // Reservation failures must NOT create or increment usage_daily
    const usageBeforeSettle = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM usage_daily`
    ).first<{ cnt: number }>();
    expect(usageBeforeSettle?.cnt).toBe(0);

    // Settle the 3 reservations: 2 used, 1 unused (0)
    await settleSingleProviderQuota(env.DB, {
      ownerUid: 'owner-uid-1',
      reservation: fulfilled[0]!.value,
      actualUsed: 1,
      d1Reads: 2,
      d1Writes: 1,
      now
    });
    await settleSingleProviderQuota(env.DB, {
      ownerUid: 'owner-uid-1',
      reservation: fulfilled[1]!.value,
      actualUsed: 1,
      d1Reads: 2,
      d1Writes: 1,
      now
    });
    await settleSingleProviderQuota(env.DB, {
      ownerUid: 'owner-uid-1',
      reservation: fulfilled[2]!.value,
      actualUsed: 0,
      d1Reads: 1,
      d1Writes: 0,
      now
    });

    const ledgerRow = await env.DB.prepare(
      `SELECT used, reserved FROM quota_ledger WHERE provider = 'gemini_text' AND window_date = ?`
    )
      .bind(pacificDate)
      .first<{ used: number; reserved: number }>();
    expect(ledgerRow).toEqual({ used: 2, reserved: 0 });

    // usage_daily must reflect exact actualUsed (2), not reserved (3)
    const usageRow = await env.DB.prepare(
      `SELECT calls FROM usage_daily WHERE owner_uid = 'owner-uid-1' AND provider = 'gemini_text' AND window_date = ?`
    )
      .bind(pacificDate)
      .first<{ calls: number }>();
    expect(usageRow?.calls).toBe(2);

    // d1_reads (includes +1 auth read per request) and d1_writes (includes +1 usage_daily write per non-zero settlement)
    const utcDate = getUtcDateString(now);
    const d1ReadsRow = await env.DB.prepare(
      `SELECT used FROM quota_ledger WHERE provider = 'd1_reads' AND window_date = ?`
    )
      .bind(utcDate)
      .first<{ used: number }>();
    const d1WritesRow = await env.DB.prepare(
      `SELECT used FROM quota_ledger WHERE provider = 'd1_writes' AND window_date = ?`
    )
      .bind(utcDate)
      .first<{ used: number }>();
    // 3 settlements: reads = (1+2) + (1+2) + (1+1) = 8
    expect(d1ReadsRow?.used).toBe(8);
    // 3 settlements: writes = (1 usage + 1 ledger + 1 extra) + (1+1+1) + (0+1+0) = 7
    expect(d1WritesRow?.used).toBe(7);
  });

  it('blocks gemini_image reservation when default daily_cap is 0 (0-won free-tier policy)', async () => {
    expect(getProviderDailyCap('gemini_image')).toBe(0);
    await expect(
      reserveProviderQuota(env.DB, {
        provider: 'gemini_image',
        amount: 1
      })
    ).rejects.toMatchObject({
      status: 429,
      code: 'QUOTA_EXCEEDED'
    });

    const usageCount = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM usage_daily').first<{
      cnt: number;
    }>();
    expect(usageCount?.cnt).toBe(0);
  });

  it('emits warnings at >=80% D1 conservative cap and blocks new generation at >=95% with 503 D1_DAILY_LIMIT_EXCEEDED', async () => {
    const now = new Date();
    const utcDate = getUtcDateString(now);
    const d1WritesCap = getProviderDailyCap('d1_writes'); // 80,000

    // 82% -> warning, not blocked
    await env.DB.prepare(
      `INSERT INTO quota_ledger (provider, window_date, reset_tz, daily_cap, used, reserved, updated_at)
       VALUES ('d1_writes', ?, 'UTC', ?, ?, 0, ?)`
    )
      .bind(utcDate, d1WritesCap, Math.floor(d1WritesCap * 0.82), now.toISOString())
      .run();

    const warnCheck = await checkD1BudgetForNewGeneration(env.DB, now);
    expect(warnCheck.warnings.length).toBeGreaterThanOrEqual(1);
    const summary = await getGlobalQuotaSummary(env.DB, now);
    const writesStatus = summary.find((s) => s.provider === 'd1_writes');
    expect(writesStatus?.warning).toBe(true);
    expect(writesStatus?.generation_blocked).toBe(false);

    // 96% -> 503 D1_DAILY_LIMIT_EXCEEDED
    await env.DB.prepare(
      `UPDATE quota_ledger SET used = ? WHERE provider = 'd1_writes' AND window_date = ?`
    )
      .bind(Math.floor(d1WritesCap * 0.96), utcDate)
      .run();

    await expect(checkD1BudgetForNewGeneration(env.DB, now)).rejects.toMatchObject({
      status: 503,
      code: 'D1_DAILY_LIMIT_EXCEEDED'
    });
  });

  it('prevents duplicate manuscript generation for the same run_id without extra LLM calls', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const nowIso = new Date().toISOString();

    // Seed category, capture (with consent), and READY topic
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('cat-idemp', 'owner-uid-1', '브이로그', 'none', NULL, '이웃공개', ?, ?, ?)`
      ).bind(
        JSON.stringify({
          category_id: 'cat-idemp',
          display_name: '브이로그',
          naver_board_name: '일상기록',
          discovery_mode: 'none',
          datalab_anchor_keyword: null,
          seed_keywords: [],
          primary_source_domains: [],
          default_media_policy: {
            allowed_content_types: ['vlog'],
            min_real_photos: 0,
            require_field_memo: true
          },
          default_visibility: '이웃공개',
          created_at: nowIso,
          updated_at: nowIso
        }),
        nowIso,
        nowIso
      ),
      env.DB.prepare(
        `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
         VALUES ('cap-idemp', 'owner-uid-1', 'cat-idemp', 'vlog', ?, ?, ?, ?)`
      ).bind(
        nowIso,
        JSON.stringify({
          capture_id: 'cap-idemp',
          category_id: 'cat-idemp',
          content_type: 'vlog',
          photos: [],
          field_memo: '주말에 공원을 산책하며 커피를 마셨다.',
          sponsorship: { is_sponsored: false },
          store_location_consent: false,
          llm_consent_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso
        }),
        nowIso,
        nowIso
      ),
      env.DB.prepare(
        `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
         VALUES ('topic-idemp', 'owner-uid-1', 'run-t1', 'personal_vlog', 'cat-idemp', 'vlog', 'READY', 'SAFE', ?, ?, ?)`
      ).bind(
        JSON.stringify({
          topic_id: 'topic-idemp',
          run_id: 'run-t1',
          track: 'personal_vlog',
          category_id: 'cat-idemp',
          content_type: 'vlog',
          status: 'READY',
          keyword: '주말 공원 산책',
          capture_ids: ['cap-idemp'],
          sources: [],
          ymyl_status: 'SAFE',
          sponsorship: { is_sponsored: false },
          datalab_demand_index: null,
          blog_supply_count: null,
          news_supply_count: null,
          monthly_search_volume: null,
          competition_score: null,
          created_at: nowIso
        }),
        nowIso,
        nowIso
      )
    ]);

    const first = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-idemp', run_id: 'fixed-run-id-001' })
    });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as {
      manuscript: { manuscript_id: string };
      reused_existing?: boolean;
    };
    expect(firstJson.reused_existing).toBe(false);

    // Second call with same run_id must reuse existing manuscript without extra Gemini call
    const second = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-idemp', run_id: 'fixed-run-id-001' })
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      manuscript: { manuscript_id: string };
      reused_existing?: boolean;
    };
    expect(secondJson.reused_existing).toBe(true);
    expect(secondJson.manuscript.manuscript_id).toBe(firstJson.manuscript.manuscript_id);

    const countRow = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM manuscripts').first<{
      cnt: number;
    }>();
    expect(countRow?.cnt).toBe(1);
  });

  it('guards run_id atomically against in-progress/cross-user conflicts (409, never 500) and releases lock on failure for retry', async () => {
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
         VALUES ('user-other-2', '다른 사용자', 'active', 'owner-uid-1', ?, ?, ?)`
      ).bind(nowIso, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('cat-lock', 'owner-uid-1', '브이로그락', 'none', NULL, '이웃공개', ?, ?, ?)`
      ).bind(
        JSON.stringify({
          category_id: 'cat-lock',
          display_name: '브이로그락',
          naver_board_name: '일상',
          discovery_mode: 'none',
          datalab_anchor_keyword: null,
          seed_keywords: [],
          primary_source_domains: [],
          default_media_policy: {
            allowed_content_types: ['vlog'],
            min_real_photos: 0,
            require_field_memo: true
          },
          default_visibility: '이웃공개',
          created_at: nowIso,
          updated_at: nowIso
        }),
        nowIso,
        nowIso
      ),
      env.DB.prepare(
        `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
         VALUES ('cap-lock', 'owner-uid-1', 'cat-lock', 'vlog', ?, ?, ?, ?)`
      ).bind(
        nowIso,
        JSON.stringify({
          capture_id: 'cap-lock',
          category_id: 'cat-lock',
          content_type: 'vlog',
          photos: [],
          field_memo: '산책 메모',
          sponsorship: { is_sponsored: false },
          store_location_consent: false,
          llm_consent_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso
        }),
        nowIso,
        nowIso
      ),
      env.DB.prepare(
        `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
         VALUES ('topic-lock', 'owner-uid-1', 'run-tl', 'personal_vlog', 'cat-lock', 'vlog', 'READY', 'SAFE', ?, ?, ?)`
      ).bind(
        JSON.stringify({
          topic_id: 'topic-lock',
          run_id: 'run-tl',
          track: 'personal_vlog',
          category_id: 'cat-lock',
          content_type: 'vlog',
          status: 'READY',
          keyword: '산책 기록',
          capture_ids: ['cap-lock'],
          sources: [],
          ymyl_status: 'SAFE',
          sponsorship: { is_sponsored: false },
          datalab_demand_index: null,
          blog_supply_count: null,
          news_supply_count: null,
          monthly_search_volume: null,
          competition_score: null,
          created_at: nowIso
        }),
        nowIso,
        nowIso
      ),
      // 1) In-progress run_id owned by caller -> 409 CONFLICT
      env.DB.prepare(
        `INSERT INTO execution_runs (run_id, owner_uid, kind, status, state_json, created_at, updated_at)
         VALUES ('run-in-progress', 'owner-uid-1', 'manuscript_generate', 'IN_PROGRESS', '{}', ?, ?)`
      ).bind(nowIso, nowIso),
      // 2) Run_id owned by another user -> 409 CONFLICT
      env.DB.prepare(
        `INSERT INTO execution_runs (run_id, owner_uid, kind, status, state_json, created_at, updated_at)
         VALUES ('run-foreign-user', 'user-other-2', 'manuscript_generate', 'COMPLETED', '{}', ?, ?)`
      ).bind(nowIso, nowIso)
    ]);

    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });

    const inProgressRes = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-lock', run_id: 'run-in-progress' })
    });
    expect(inProgressRes.status).toBe(409);
    expect(((await inProgressRes.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');

    const foreignRes = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-lock', run_id: 'run-foreign-user' })
    });
    expect(foreignRes.status).toBe(409);
    expect(((await foreignRes.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');

    // 3) LLM fails on first attempt -> IN_PROGRESS lock released & usage_daily NOT incremented (Minor 1) -> retry succeeds!
    let failDraftOnce = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        const reqText = String(init?.body ?? '');
        if (reqText.includes('YMYL')) {
          return new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: '{"verdict":"SAFE","reason":"ok"}' }] } }]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (failDraftOnce) {
          failDraftOnce = false;
          return new Response('Upstream error', { status: 503 });
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title_candidates: ['재시도 성공 원고'],
                        selected_title: '재시도 성공 원고',
                        body_html: '<p>재시도 후 정상 생성되었습니다.</p>',
                        tags: ['재시도'],
                        claims: []
                      })
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const failedAttempt = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-lock', run_id: 'run-retryable-1' })
    });
    expect(failedAttempt.status).toBe(502);

    // Retry with same run_id succeeds because failed IN_PROGRESS lock was released
    const retryAttempt = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-lock', run_id: 'run-retryable-1' })
    });
    expect(retryAttempt.status).toBe(201);
  });
});
