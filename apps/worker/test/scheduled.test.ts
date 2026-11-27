import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { R2Bucket, R2Objects } from '@cloudflare/workers-types';
import {
  APP_META_R2_SCAN_ACCUM_BYTES,
  APP_META_R2_SCAN_CONSECUTIVE_FAILURES,
  APP_META_R2_SCAN_CURSOR,
  APP_META_R2_USAGE_BYTES
} from '../src/repositories/cron.repo.js';
import {
  findLogNoRankInBlogItems,
  runScheduledTasks,
  ScheduledRunError
} from '../src/jobs/scheduled.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
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

async function seedPublishedPost(params: {
  ownerUid: string;
  postId: string;
  logNo: string;
  blogId?: string;
  keywords: string[];
  publishedAtIso: string;
  trackUntil: string;
  lastTrackedDate?: string | null;
}) {
  const catId = `cat-${params.ownerUid}`;
  const topicId = `topic-${params.postId}`;
  const msId = `ms-${params.postId}`;
  const blogId = params.blogId ?? 'testblog';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
       VALUES (?, ?, '테크/IT', 'trend_first', '기준', '전체공개', '{}', ?, ?)`
    ).bind(catId, params.ownerUid, params.publishedAtIso, params.publishedAtIso),
    env.DB.prepare(
      `INSERT OR IGNORE INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
       VALUES (?, ?, ?, 'category_discovery', ?, 'explainer', 'READY', 'SAFE', '{}', ?, ?)`
    ).bind(topicId, params.ownerUid, `run-${topicId}`, catId, params.publishedAtIso, params.publishedAtIso),
    env.DB.prepare(
      `INSERT OR IGNORE INTO manuscripts (manuscript_id, owner_uid, topic_id, category_id, content_type, run_id, version, content_hash, approved_hash, approved_at, unresolved_verify_count, bundle_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'explainer', ?, 1, 'h', 'h', ?, 0, '{}', ?, ?)`
    ).bind(msId, params.ownerUid, topicId, catId, `ms-run-${msId}`, params.publishedAtIso, params.publishedAtIso, params.publishedAtIso),
    env.DB.prepare(
      `INSERT INTO published_posts (post_id, owner_uid, manuscript_id, category_id, log_no, post_url, target_keywords_json, published_at, track_until, last_tracked_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      params.postId,
      params.ownerUid,
      msId,
      catId,
      params.logNo,
      `https://blog.naver.com/${blogId}/${params.logNo}`,
      JSON.stringify(params.keywords),
      params.publishedAtIso,
      params.trackUntil,
      params.lastTrackedDate ?? null
    )
  ]);
}

beforeEach(async () => {
  await clearAllTables();
  vi.restoreAllMocks();
});

describe('Phase 4 Scheduled Cron: rank tracking, usage_daily cleanup, R2 scan & orphan cleanup', () => {
  it('tracks active users round-robin (max 10 pairs), excludes blocked/expired posts, matches path & logNo= with blogId, settles global quota only (never usage_daily)', async () => {
    const now = new Date('2026-11-26T01:00:00.000Z');
    const nowIso = now.toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
         VALUES ('user-active-a', '활성 A', 'active', 'owner-uid-1', ?, ?, ?)`
      ).bind(nowIso, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
         VALUES ('user-blocked-b', '차단 B', 'blocked', 'owner-uid-1', ?, ?, ?)`
      ).bind(nowIso, nowIso, nowIso)
    ]);

    await seedPublishedPost({
      ownerUid: 'owner-uid-1',
      postId: 'post-admin-1',
      logNo: '111001',
      blogId: 'myblog',
      keywords: ['adm-k1', 'adm-k2', 'adm-k3', 'adm-k4', 'adm-k5'],
      publishedAtIso: '2026-11-20T01:00:00.000Z',
      trackUntil: '2026-12-20'
    });
    await seedPublishedPost({
      ownerUid: 'owner-uid-1',
      postId: 'post-admin-2',
      logNo: '111002',
      blogId: 'myblog',
      keywords: ['adm-k6', 'adm-k7'],
      publishedAtIso: '2026-11-21T01:00:00.000Z',
      trackUntil: '2026-12-21'
    });
    await seedPublishedPost({
      ownerUid: 'owner-uid-1',
      postId: 'post-admin-expired',
      logNo: '111999',
      blogId: 'myblog',
      keywords: ['expired-kw'],
      publishedAtIso: '2026-10-01T01:00:00.000Z',
      trackUntil: '2026-11-01'
    });

    await seedPublishedPost({
      ownerUid: 'user-active-a',
      postId: 'post-usera-1',
      logNo: '222001',
      blogId: 'usera',
      keywords: ['ua-k1', 'ua-k2', 'ua-k3', 'ua-k4', 'ua-k5'],
      publishedAtIso: '2026-11-20T01:00:00.000Z',
      trackUntil: '2026-12-20'
    });
    await seedPublishedPost({
      ownerUid: 'user-active-a',
      postId: 'post-usera-2',
      logNo: '222002',
      blogId: 'usera',
      keywords: ['ua-k6'],
      publishedAtIso: '2026-11-21T01:00:00.000Z',
      trackUntil: '2026-12-21'
    });

    await seedPublishedPost({
      ownerUid: 'user-blocked-b',
      postId: 'post-blocked-1',
      logNo: '333001',
      blogId: 'blockedblog',
      keywords: ['blocked-kw'],
      publishedAtIso: '2026-11-20T01:00:00.000Z',
      trackUntil: '2026-12-20'
    });

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const calledQueries: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const q = url.searchParams.get('query') ?? '';
      calledQueries.push(q);
      expect(url.searchParams.get('display')).toBe('100');

      if (q === 'adm-k1') {
        return new Response(
          JSON.stringify({
            items: [
              { link: 'https://blog.naver.com/other/999' },
              { link: 'https://blog.naver.com/myblog/111001' }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (q === 'ua-k1') {
        return new Response(
          JSON.stringify({
            items: [
              { link: 'https://blog.naver.com/other/1' },
              { link: 'https://blog.naver.com/other/2' },
              { link: 'https://blog.naver.com/PostView.naver?blogId=usera&logNo=222001' }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ items: [{ link: 'https://blog.naver.com/other/777' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const result = await runScheduledTasks(env, now);
    expect(result.errors).toHaveLength(0);
    expect(result.rankTracking.status).toBe('ok');
    expect(result.rankTracking.kstToday).toBe('2026-11-26');
    expect(result.rankTracking.checkedPairs).toBe(10);
    expect(result.rankTracking.nonOkResponses).toBe(0);
    expect(result.rankTracking.completedPosts).toBe(2);
    expect(infoSpy).toHaveBeenCalledWith('[scheduled] summary', expect.any(String));

    expect(calledQueries.filter((q) => q.startsWith('adm-'))).toHaveLength(5);
    expect(calledQueries.filter((q) => q.startsWith('ua-'))).toHaveLength(5);
    expect(calledQueries).not.toContain('blocked-kw');
    expect(calledQueries).not.toContain('expired-kw');

    const ranks = await env.DB.prepare(
      'SELECT owner_uid, post_id, keyword, rank, checked_date FROM rank_history ORDER BY keyword ASC'
    ).all<{ owner_uid: string; post_id: string; keyword: string; rank: number | null; checked_date: string }>();
    expect(ranks.results).toHaveLength(10);
    expect(ranks.results.find((r) => r.keyword === 'adm-k1')?.rank).toBe(2);
    expect(ranks.results.find((r) => r.keyword === 'ua-k1')?.rank).toBe(3);
    expect(ranks.results.find((r) => r.keyword === 'adm-k2')?.rank).toBeNull();

    const naverQuota = await env.DB.prepare(
      `SELECT used, reserved FROM quota_ledger WHERE provider = 'naver_search' AND window_date = '2026-11-26'`
    ).first<{ used: number; reserved: number }>();
    expect(naverQuota).toEqual({ used: 10, reserved: 0 });

    const usageDailyCount = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM usage_daily').first<{
      cnt: number;
    }>();
    expect(usageDailyCount?.cnt).toBe(0);
  });

  it('excludes items with matching logNo but different blogId in findLogNoRankInBlogItems', () => {
    const items = [
      {
        link: 'https://blog.naver.com/stranger_blog/123456',
        bloggerlink: 'https://blog.naver.com/stranger_blog'
      },
      {
        link: 'https://blog.naver.com/PostView.naver?blogId=other_person&logNo=123456',
        bloggerlink: 'https://blog.naver.com/other_person'
      },
      {
        link: 'https://blog.naver.com/my_official_blog/123456',
        bloggerlink: 'https://blog.naver.com/my_official_blog'
      }
    ];

    expect(
      findLogNoRankInBlogItems(items, '123456', 'https://blog.naver.com/my_official_blog/123456')
    ).toBe(3);

    expect(
      findLogNoRankInBlogItems(
        items.slice(0, 2),
        '123456',
        'https://blog.naver.com/my_official_blog/123456'
      )
    ).toBeNull();
  });

  it('deletes usage_daily rows older than 30 days while keeping recent rows', async () => {
    const now = new Date('2026-11-26T01:00:00.000Z');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls)
         VALUES ('owner-uid-1', 'naver_search', '2026-10-01', 15)`
      ),
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls)
         VALUES ('owner-uid-1', 'gemini_text', '2026-10-20', 8)`
      ),
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls)
         VALUES ('owner-uid-1', 'naver_search', '2026-11-20', 4)`
      )
    ]);

    const res = await runScheduledTasks(env, now);
    expect(res.usageCleanup.status).toBe('ok');
    expect(res.usageCleanup.deletedRows).toBe(2);

    const remaining = await env.DB.prepare('SELECT window_date FROM usage_daily').all<{
      window_date: string;
    }>();
    expect(remaining.results.map((r) => r.window_date)).toEqual(['2026-11-20']);
  });

  it('paginates R2 list once per cron run, protects malformed capture_json rows by capture_id, deletes max 20 unregistered captures >24h, and caches total r2_usage_bytes', async () => {
    const now = new Date('2026-11-26T12:00:00.000Z');
    const nowIso = now.toISOString();
    const oldDate = new Date(now.getTime() - 26 * 60 * 60 * 1000);
    const freshDate = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('cat-1', 'owner-uid-1', '맛집', 'experience_first', '맛집', '전체공개', '{}', ?, ?)`
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
         VALUES ('cap-reg', 'owner-uid-1', 'cat-1', 'experience_review', NULL, ?, ?, ?)`
      ).bind(
        JSON.stringify({
          photos: [{ seq: 1, r2_key: 'users/owner-uid-1/captures/cap-reg/1.webp', byte_size: 1000 }]
        }),
        nowIso,
        nowIso
      ),
      // 손상된 capture_json 행: D1에 capture_id가 존재하므로 하위 R2 객체는 절대 삭제되면 안 됨 (권장 3)
      env.DB.prepare(
        `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
         VALUES ('cap-corrupt', 'owner-uid-1', 'cat-1', 'experience_review', NULL, '{broken-json', ?, ?)`
      ).bind(nowIso, nowIso)
    ]);

    const page1Objects = [
      ...Array.from({ length: 25 }, (_, i) => ({
        key: `users/owner-uid-1/captures/cap-orphan-${i + 1}/1.webp`,
        size: 100,
        uploaded: oldDate
      })),
      { key: 'users/owner-uid-1/captures/cap-reg/1.webp', size: 1000, uploaded: oldDate },
      { key: 'users/owner-uid-1/captures/cap-corrupt/1.webp', size: 1500, uploaded: oldDate },
      { key: 'users/owner-uid-1/captures/cap-fresh/1.webp', size: 500, uploaded: freshDate },
      { key: 'users/owner-uid-1/snapshots/top-1/snap-1.txt', size: 2000, uploaded: oldDate }
    ];
    const page2Objects = [
      { key: 'users/owner-uid-1/snapshots/top-2/snap-2.txt', size: 3000, uploaded: oldDate }
    ];

    const deletedKeys: string[] = [];
    const listMock = vi.fn(async (opts?: { cursor?: string; prefix?: string; limit?: number }) => {
      expect(opts?.prefix).toBe('users/');
      expect(opts?.limit).toBe(500);
      if (!opts?.cursor) {
        return {
          objects: page1Objects,
          truncated: true,
          cursor: 'cursor-page-2',
          delimitedPrefixes: []
        } as unknown as R2Objects;
      }
      return {
        objects: page2Objects,
        truncated: false,
        delimitedPrefixes: []
      } as unknown as R2Objects;
    });
    const deleteMock = vi.fn(async (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      deletedKeys.push(...arr);
    });

    const mockEnv = {
      ...env,
      MEDIA_BUCKET: {
        list: listMock,
        delete: deleteMock
      } as unknown as R2Bucket
    };

    const run1 = await runScheduledTasks(mockEnv, now);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(run1.r2Maintenance.status).toBe('ok');
    expect(run1.r2Maintenance.orphanDeletedCount).toBe(20);
    expect(run1.r2Maintenance.scanCompletedCycle).toBe(false);
    expect(deletedKeys).toHaveLength(20);
    expect(deletedKeys).not.toContain('users/owner-uid-1/captures/cap-reg/1.webp');
    expect(deletedKeys).not.toContain('users/owner-uid-1/captures/cap-corrupt/1.webp');
    expect(deletedKeys).not.toContain('users/owner-uid-1/captures/cap-fresh/1.webp');
    expect(deletedKeys).not.toContain('users/owner-uid-1/snapshots/top-1/snap-1.txt');

    const savedCursor = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?')
      .bind(APP_META_R2_SCAN_CURSOR)
      .first<{ value: string }>();
    expect(savedCursor?.value).toBe('cursor-page-2');

    // Run 2: Page 1 post-delete (5*100 + 1000 + 1500 + 500 + 2000 = 5500) + Page 2 (3000) = 8500
    const run2 = await runScheduledTasks(mockEnv, now);
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(run2.r2Maintenance.scanCompletedCycle).toBe(true);
    expect(run2.r2Maintenance.cachedUsageBytes).toBe(8500);

    const cachedUsage = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?')
      .bind(APP_META_R2_USAGE_BYTES)
      .first<{ value: string }>();
    expect(cachedUsage?.value).toBe('8500');
  });

  it('resets stuck R2 cursor on failure, records consecutive failures, recovers on next run, and throws ScheduledRunError on errors after running all tasks', async () => {
    const now = new Date('2026-11-26T01:00:00.000Z');
    const nowIso = now.toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, 'stale-broken-cursor', ?)`
      ).bind(APP_META_R2_SCAN_CURSOR, nowIso),
      env.DB.prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, '4321', ?)`
      ).bind(APP_META_R2_SCAN_ACCUM_BYTES, nowIso),
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls)
         VALUES ('owner-uid-1', 'naver_search', '2026-09-01', 3)`
      )
    ]);

    await seedPublishedPost({
      ownerUid: 'owner-uid-1',
      postId: 'post-err-1',
      logNo: '555001',
      blogId: 'myblog',
      keywords: ['err-kw'],
      publishedAtIso: '2026-11-20T01:00:00.000Z',
      trackUntil: '2026-12-20'
    });

    // Naver returns HTTP 500 -> counted in nonOkResponses & errors
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Upstream Error', { status: 500 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const listMock = vi.fn(async (opts?: { cursor?: string }) => {
      if (opts?.cursor === 'stale-broken-cursor') {
        throw new Error('Invalid R2 cursor');
      }
      return {
        objects: [{ key: 'users/owner-uid-1/snapshots/t/s.txt', size: 1200, uploaded: now }],
        truncated: false,
        delimitedPrefixes: []
      } as unknown as R2Objects;
    });

    const mockEnv = {
      ...env,
      MEDIA_BUCKET: {
        list: listMock,
        delete: vi.fn()
      } as unknown as R2Bucket
    };

    // Run 1: both rankTracking (500) and R2 (invalid cursor) fail, yet usageCleanup still completes AND ScheduledRunError is thrown
    let caught: unknown = null;
    try {
      await runScheduledTasks(mockEnv, now);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ScheduledRunError);
    const runErr = caught as ScheduledRunError;
    expect(runErr.result.rankTracking.nonOkResponses).toBe(1);
    expect(runErr.result.rankTracking.errors).toHaveLength(1);
    expect(runErr.result.usageCleanup.status).toBe('ok');
    expect(runErr.result.usageCleanup.deletedRows).toBe(1);
    expect(runErr.result.r2Maintenance.status).toBe('error');
    expect(runErr.result.r2Maintenance.cursorReset).toBe(true);
    expect(runErr.result.r2Maintenance.consecutiveFailures).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('[scheduled] errors', expect.any(String));

    // Verify cursor & accum reset and consecutive failures = 1 persisted in app_meta
    const metaRows = await env.DB.prepare(
      `SELECT key, value FROM app_meta WHERE key IN (?, ?, ?)`
    )
      .bind(
        APP_META_R2_SCAN_CURSOR,
        APP_META_R2_SCAN_ACCUM_BYTES,
        APP_META_R2_SCAN_CONSECUTIVE_FAILURES
      )
      .all<{ key: string; value: string }>();
    const metaMap = new Map(metaRows.results.map((r) => [r.key, r.value]));
    expect(metaMap.get(APP_META_R2_SCAN_CURSOR)).toBe('');
    expect(metaMap.get(APP_META_R2_SCAN_ACCUM_BYTES)).toBe('0');
    expect(metaMap.get(APP_META_R2_SCAN_CONSECUTIVE_FAILURES)).toBe('1');

    // Run 2: Naver returns 200 and R2 scans cleanly without cursor -> resets consecutiveFailures to 0!
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ link: 'https://blog.naver.com/myblog/555001' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const recovered = await runScheduledTasks(mockEnv, now);
    expect(recovered.errors).toHaveLength(0);
    expect(recovered.r2Maintenance.status).toBe('ok');
    expect(recovered.r2Maintenance.scanCompletedCycle).toBe(true);
    expect(recovered.r2Maintenance.cachedUsageBytes).toBe(1200);
    expect(recovered.r2Maintenance.consecutiveFailures).toBe(0);

    const resetFailRow = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?')
      .bind(APP_META_R2_SCAN_CONSECUTIVE_FAILURES)
      .first<{ value: string }>();
    expect(resetFailRow?.value).toBe('0');
  });
});
