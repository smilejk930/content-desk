import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportResponseSchema } from '@content-desk/shared';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-isolation-test');
});

async function clearAllTables() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rank_history'),
    env.DB.prepare('DELETE FROM published_posts'),
    env.DB.prepare('DELETE FROM manuscripts'),
    env.DB.prepare('DELETE FROM source_snapshots'),
    env.DB.prepare('DELETE FROM topics'),
    env.DB.prepare('DELETE FROM captures'),
    env.DB.prepare('DELETE FROM categories'),
    env.DB.prepare('DELETE FROM execution_runs'),
    env.DB.prepare('DELETE FROM daily_visitors'),
    env.DB.prepare('DELETE FROM user_meta'),
    env.DB.prepare('DELETE FROM usage_daily'),
    env.DB.prepare('DELETE FROM quota_ledger'),
    env.DB.prepare('DELETE FROM api_cache'),
    env.DB.prepare('DELETE FROM app_meta'),
    env.DB.prepare('DELETE FROM users')
  ]);
}

async function seedOwnerDataset(ownerUid: string, prefix: string, nowIso: string) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
       VALUES (?, ?, ?, 'trend_first', '테크', '전체공개', '{}', ?, ?)`
    ).bind(`${prefix}-cat`, ownerUid, '테크/IT', nowIso, nowIso),
    env.DB.prepare(
      `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
       VALUES (?, ?, ?, 'experience_review', ?, '{}', ?, ?)`
    ).bind(`${prefix}-cap`, ownerUid, `${prefix}-cat`, nowIso, nowIso, nowIso),
    env.DB.prepare(
      `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
       VALUES (?, ?, ?, 'category_discovery', ?, 'explainer', 'READY', 'SAFE', '{}', ?, ?)`
    ).bind(`${prefix}-topic`, ownerUid, `${prefix}-run`, `${prefix}-cat`, nowIso, nowIso),
    env.DB.prepare(
      `INSERT INTO source_snapshots (snapshot_id, owner_uid, topic_id, url, domain, ingest_channel, r2_key, body_sha256, char_count, fetched_at)
       VALUES (?, ?, ?, 'https://example.com/doc', 'example.com', 'manual_input', ?, 'abc', 100, ?)`
    ).bind(`${prefix}-snap`, ownerUid, `${prefix}-topic`, `users/${ownerUid}/snapshots/1.txt`, nowIso),
    env.DB.prepare(
      `INSERT INTO manuscripts (manuscript_id, owner_uid, topic_id, category_id, content_type, run_id, version, content_hash, approved_hash, approved_at, unresolved_verify_count, bundle_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'explainer', ?, 1, 'hash-1', 'hash-1', ?, 0, '{}', ?, ?)`
    ).bind(
      `${prefix}-ms`,
      ownerUid,
      `${prefix}-topic`,
      `${prefix}-cat`,
      `${prefix}-run`,
      nowIso,
      nowIso,
      nowIso
    ),
    env.DB.prepare(
      `INSERT INTO execution_runs (run_id, owner_uid, kind, status, state_json, created_at, updated_at)
       VALUES (?, ?, 'discovery', 'DONE', '{}', ?, ?)`
    ).bind(`${prefix}-run`, ownerUid, nowIso, nowIso),
    env.DB.prepare(
      `INSERT INTO published_posts (post_id, owner_uid, manuscript_id, category_id, log_no, post_url, target_keywords_json, published_at, track_until, last_tracked_date)
       VALUES (?, ?, ?, ?, '123456', 'https://blog.naver.com/test/123456', '["kw"]', ?, '2026-12-23', NULL)`
    ).bind(`${prefix}-post`, ownerUid, `${prefix}-ms`, `${prefix}-cat`, nowIso),
    env.DB.prepare(
      `INSERT INTO rank_history (id, owner_uid, post_id, keyword, rank, checked_date, checked_at)
       VALUES (?, ?, ?, 'kw', 3, '2026-11-23', ?)`
    ).bind(`${prefix}-rank`, ownerUid, `${prefix}-post`, nowIso),
    env.DB.prepare(
      `INSERT INTO daily_visitors (owner_uid, visit_date, visitor_count, updated_at)
       VALUES (?, '2026-11-23', 42, ?)`
    ).bind(ownerUid, nowIso),
    env.DB.prepare(
      `INSERT INTO user_meta (owner_uid, key, value, updated_at)
       VALUES (?, 'custom_pref', ?, ?)`
    ).bind(ownerUid, `${prefix}-pref-value`, nowIso)
  ]);
}

beforeEach(async () => {
  clearFirebaseCertCacheForTests();
  await clearAllTables();
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

describe('사람별 데이터 격리 (사용자 A / 사용자 B / 관리자 및 D1 복합 FK)', () => {
  it('isolates POST /api/export strictly to caller owner_uid (including admin) and excludes global/admin tables', async () => {
    const nowIso = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
         VALUES (?, ?, 'active', 'owner-uid-1', ?, ?, ?)`
      ).bind('user-a-001', '사용자 A', nowIso, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
         VALUES (?, ?, 'active', 'owner-uid-1', ?, ?, ?)`
      ).bind('user-b-002', '사용자 B', nowIso, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO quota_ledger (provider, window_date, reset_tz, daily_cap, used, reserved, updated_at)
         VALUES ('naver_search', '2026-11-23', 'UTC', 25000, 10, 0, ?)`
      ).bind(nowIso),
      env.DB.prepare(
        `INSERT INTO api_cache (cache_key, payload_json, expires_at, backoff_until)
         VALUES ('k1', '{}', ?, NULL)`
      ).bind(nowIso),
      env.DB.prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES ('global_version', '1.5', ?)`
      ).bind(nowIso),
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls)
         VALUES ('user-a-001', 'naver_search', '2026-11-23', 5)`
      )
    ]);

    await seedOwnerDataset('user-a-001', 'ua', nowIso);
    await seedOwnerDataset('user-b-002', 'ub', nowIso);
    await seedOwnerDataset('owner-uid-1', 'adm', nowIso);

    for (const actor of [
      { uid: 'user-a-001', prefix: 'ua', otherPrefixes: ['ub', 'adm'] },
      { uid: 'user-b-002', prefix: 'ub', otherPrefixes: ['ua', 'adm'] },
      { uid: 'owner-uid-1', prefix: 'adm', otherPrefixes: ['ua', 'ub'] }
    ]) {
      const token = await signFirebaseToken({ keyPair, sub: actor.uid });
      const res = await SELF.fetch('https://worker.test/api/export', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(res.status).toBe(200);
      const raw = await res.json();
      const parsed = exportResponseSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;

      const data = parsed.data.data;
      const rawRecord = (raw as { data: Record<string, unknown> }).data;

      // Global & admin-only tables must be completely absent
      expect(rawRecord.users).toBeUndefined();
      expect(rawRecord.usage_daily).toBeUndefined();
      expect(rawRecord.quota_ledger).toBeUndefined();
      expect(rawRecord.api_cache).toBeUndefined();
      expect(rawRecord.app_meta).toBeUndefined();

      // Every single exported row across all 10 per-user tables must belong to actor.uid
      for (const rows of Object.values(data)) {
        expect(rows.length).toBeGreaterThanOrEqual(1);
        for (const row of rows) {
          expect(row.owner_uid).toBe(actor.uid);
        }
      }

      // Verify custom_pref and last_full_export_at are isolated per user
      const customMeta = data.user_meta.find((m) => m.key === 'custom_pref');
      expect(customMeta?.value).toBe(`${actor.prefix}-pref-value`);
      const exportMeta = data.user_meta.find((m) => m.key === 'last_full_export_at');
      expect(exportMeta?.value).toBe(parsed.data.exported_at);

      // Ensure no other user's IDs leaked into serialized payload
      const text = JSON.stringify(data);
      for (const other of actor.otherPrefixes) {
        expect(text).not.toContain(`${other}-cat`);
        expect(text).not.toContain(`${other}-ms`);
        expect(text).not.toContain(`${other}-pref-value`);
      }
    }

    // Confirm user_meta has 3 independent last_full_export_at rows
    const metaRows = await env.DB.prepare(
      "SELECT owner_uid, key FROM user_meta WHERE key = 'last_full_export_at' ORDER BY owner_uid ASC"
    ).all<{ owner_uid: string; key: string }>();
    expect(metaRows.results.map((r) => r.owner_uid)).toEqual([
      'owner-uid-1',
      'user-a-001',
      'user-b-002'
    ]);
  });

  it('enforces D1 composite foreign keys to reject cross-owner category_id and topic_id references', async () => {
    const nowIso = new Date().toISOString();

    // User A creates a category and a topic
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('cat-owner-a', 'user-a-001', '맛집', 'experience_first', '맛집', '전체공개', '{}', ?, ?)`
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('cat-owner-b', 'user-b-002', '맛집', 'experience_first', '맛집', '전체공개', '{}', ?, ?)`
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
         VALUES ('topic-owner-a', 'user-a-001', 'run-a-1', 'category_discovery', 'cat-owner-a', 'explainer', 'READY', 'SAFE', '{}', ?, ?)`
      ).bind(nowIso, nowIso)
    ]);

    // User B tries to insert a capture referencing User A's category_id -> MUST FAIL
    await expect(
      env.DB.prepare(
        `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
         VALUES ('cap-cross-1', 'user-b-002', 'cat-owner-a', 'experience_review', NULL, '{}', ?, ?)`
      )
        .bind(nowIso, nowIso)
        .run()
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);

    // User B tries to insert a topic referencing User A's category_id -> MUST FAIL
    await expect(
      env.DB.prepare(
        `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
         VALUES ('topic-cross-1', 'user-b-002', 'run-b-1', 'category_discovery', 'cat-owner-a', 'explainer', 'READY', 'SAFE', '{}', ?, ?)`
      )
        .bind(nowIso, nowIso)
        .run()
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);

    // User B tries to insert a source_snapshot referencing User A's topic_id -> MUST FAIL
    await expect(
      env.DB.prepare(
        `INSERT INTO source_snapshots (snapshot_id, owner_uid, topic_id, url, domain, ingest_channel, r2_key, body_sha256, char_count, fetched_at)
         VALUES ('snap-cross-1', 'user-b-002', 'topic-owner-a', 'https://example.com', 'example.com', 'manual_input', 'k', 'h', 10, ?)`
      )
        .bind(nowIso)
        .run()
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);

    // User B tries to insert a manuscript referencing User A's topic_id -> MUST FAIL
    await expect(
      env.DB.prepare(
        `INSERT INTO manuscripts (manuscript_id, owner_uid, topic_id, category_id, content_type, run_id, version, content_hash, approved_hash, approved_at, unresolved_verify_count, bundle_json, created_at, updated_at)
         VALUES ('ms-cross-1', 'user-b-002', 'topic-owner-a', 'cat-owner-b', 'explainer', 'run-b-ms', 1, 'h', NULL, NULL, 0, '{}', ?, ?)`
      )
        .bind(nowIso, nowIso)
        .run()
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('isolates Phase 2 categories, captures, presign, and consent APIs from both other users and admin (404 NOT_FOUND + 0 list rows)', async () => {
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
         VALUES (?, ?, 'active', 'owner-uid-1', ?, ?, ?)`
      ).bind('user-a-001', '사용자 A', nowIso, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
         VALUES (?, ?, 'active', 'owner-uid-1', ?, ?, ?)`
      ).bind('user-b-002', '사용자 B', nowIso, nowIso, nowIso)
    ]);

    const tokenA = await signFirebaseToken({ keyPair, sub: 'user-a-001' });
    const tokenB = await signFirebaseToken({ keyPair, sub: 'user-b-002' });
    const tokenAdmin = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });

    // User A creates a category and a capture
    const catRes = await SELF.fetch('https://worker.test/api/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: '성수 카페',
        naver_board_name: '카페',
        discovery_mode: 'experience_first',
        datalab_anchor_keyword: '성수동 카페',
        seed_keywords: ['드립커피'],
        primary_source_domains: [],
        default_media_policy: {
          allowed_content_types: ['experience_review'],
          min_real_photos: 0,
          require_field_memo: true
        },
        default_visibility: '전체공개'
      })
    });
    expect(catRes.status).toBe(201);
    const { category } = (await catRes.json()) as { category: { category_id: string } };

    const capRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: category.category_id,
        content_type: 'experience_review',
        photos: [],
        field_memo: '사용자 A의 비공개 현장 메모',
        sponsorship: { is_sponsored: false }
      })
    });
    expect(capRes.status).toBe(201);
    const { capture } = (await capRes.json()) as { capture: { capture_id: string } };

    // Both User B and Admin must see 0 rows in list APIs and receive 404 NOT_FOUND on every targeted endpoint
    for (const otherToken of [tokenB, tokenAdmin]) {
      const catList = await SELF.fetch('https://worker.test/api/categories', {
        headers: { Authorization: `Bearer ${otherToken}` }
      });
      expect(catList.status).toBe(200);
      expect(((await catList.json()) as { categories: unknown[] }).categories).toHaveLength(0);

      const catPatch = await SELF.fetch(
        `https://worker.test/api/categories/${category.category_id}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${otherToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ naver_board_name: '탈취시도' })
        }
      );
      expect(catPatch.status).toBe(404);
      expect(((await catPatch.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

      const catDel = await SELF.fetch(
        `https://worker.test/api/categories/${category.category_id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${otherToken}` }
        }
      );
      expect(catDel.status).toBe(404);
      expect(((await catDel.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

      const presignCross = await SELF.fetch('https://worker.test/api/captures/presign', {
        method: 'POST',
        headers: { Authorization: `Bearer ${otherToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capture_id: 'cap-cross-presign',
          category_id: category.category_id,
          files: [{ seq: 1, content_type: 'image/webp', byte_size: 1024 }]
        })
      });
      expect(presignCross.status).toBe(404);
      expect(((await presignCross.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

      const createCrossCapture = await SELF.fetch('https://worker.test/api/captures', {
        method: 'POST',
        headers: { Authorization: `Bearer ${otherToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category_id: category.category_id,
          content_type: 'experience_review',
          photos: [],
          field_memo: '타인 카테고리 참조 시도'
        })
      });
      expect(createCrossCapture.status).toBe(404);
      expect(((await createCrossCapture.json()) as { error: { code: string } }).error.code).toBe(
        'NOT_FOUND'
      );

      const capList = await SELF.fetch('https://worker.test/api/captures', {
        headers: { Authorization: `Bearer ${otherToken}` }
      });
      expect(capList.status).toBe(200);
      expect(((await capList.json()) as { captures: unknown[] }).captures).toHaveLength(0);

      const capDetail = await SELF.fetch(
        `https://worker.test/api/captures/${capture.capture_id}`,
        {
          headers: { Authorization: `Bearer ${otherToken}` }
        }
      );
      expect(capDetail.status).toBe(404);
      expect(((await capDetail.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

      const capConsent = await SELF.fetch(
        `https://worker.test/api/captures/${capture.capture_id}/consent`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${otherToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ acknowledged_free_tier_training: true })
        }
      );
      expect(capConsent.status).toBe(404);
      expect(((await capConsent.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }

    // Verify User A's category and capture remain intact and unconsented
    const verifyA = await SELF.fetch(`https://worker.test/api/captures/${capture.capture_id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    expect(verifyA.status).toBe(200);
    const verifiedBody = (await verifyA.json()) as { capture: { llm_consent_at: string | null } };
    expect(verifiedBody.capture.llm_consent_at).toBeNull();
  });
});
