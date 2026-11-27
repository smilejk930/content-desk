import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dashboardSummaryResponseSchema,
  mediaDownloadUrlsResponseSchema,
  publishedPostResponseSchema,
  publishedPostsListResponseSchema,
  R2_FREE_LIMIT_BYTES,
  settingsResponseSchema
} from '@content-desk/shared';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-phase4-publish');
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

async function seedCategoryTopicManuscript(params: {
  ownerUid: string;
  catId: string;
  catName: string;
  topicId: string;
  msId: string;
  approved: boolean;
  approvedAtIso?: string;
  images?: Array<{ seq: number; r2_key: string; caption: string; is_ai_generated: boolean }>;
  nowIso: string;
}) {
  const hash = 'a'.repeat(64);
  const approvedHash = params.approved ? hash : null;
  const approvedAt = params.approved ? (params.approvedAtIso ?? params.nowIso) : null;
  const bundle = {
    manuscript_id: params.msId,
    topic_id: params.topicId,
    version: 1,
    content_hash: hash,
    title_candidates: ['테스트 제목'],
    selected_title: `제목-${params.msId}`,
    body_html: '<p>본문 내용</p>',
    naver_board_name: 'IT해설',
    sponsorship: { is_sponsored: false },
    ftc_disclosure: null,
    ai_disclosure: null,
    images: params.images ?? [],
    tags: ['테스트'],
    visibility: '전체공개',
    claims: [],
    ngram_max_similarity: null,
    sanitized_at: params.nowIso,
    approved_hash: approvedHash,
    approved_at: approvedAt
  };

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
       VALUES (?, ?, ?, 'trend_first', '기준키워드', '전체공개', '{}', ?, ?)`
    ).bind(params.catId, params.ownerUid, params.catName, params.nowIso, params.nowIso),
    env.DB.prepare(
      `INSERT OR IGNORE INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
       VALUES (?, ?, ?, 'category_discovery', ?, 'explainer', 'READY', 'SAFE', '{}', ?, ?)`
    ).bind(params.topicId, params.ownerUid, `run-${params.topicId}`, params.catId, params.nowIso, params.nowIso),
    env.DB.prepare(
      `INSERT INTO manuscripts (manuscript_id, owner_uid, topic_id, category_id, content_type, run_id, version, content_hash, approved_hash, approved_at, unresolved_verify_count, bundle_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'explainer', ?, 1, ?, ?, ?, 0, ?, ?, ?)`
    ).bind(
      params.msId,
      params.ownerUid,
      params.topicId,
      params.catId,
      `ms-run-${params.msId}`,
      hash,
      approvedHash,
      approvedAt,
      JSON.stringify(bundle),
      params.nowIso,
      params.nowIso
    )
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
    throw new Error(`Unexpected fetch: ${url}`);
  });
});

describe('Phase 4 Worker APIs: media download-urls, published-posts, visitors, dashboard, settings', () => {
  it('issues 10-min R2 GET presigned URLs for owner manuscript & capture and returns 503 when R2 signer config is missing', async () => {
    const nowIso = new Date().toISOString();
    const uid = 'owner-uid-1';

    await seedCategoryTopicManuscript({
      ownerUid: uid,
      catId: 'cat-1',
      catName: '테크/IT',
      topicId: 'top-1',
      msId: 'ms-1',
      approved: true,
      images: [
        { seq: 1, r2_key: `users/${uid}/captures/cap-1/1.webp`, caption: '첫 사진', is_ai_generated: false }
      ],
      nowIso
    });

    await env.DB.prepare(
      `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
       VALUES ('cap-1', ?, 'cat-1', 'experience_review', ?, ?, ?, ?)`
    )
      .bind(
        uid,
        nowIso,
        JSON.stringify({
          capture_id: 'cap-1',
          category_id: 'cat-1',
          content_type: 'experience_review',
          photos: [
            {
              seq: 1,
              r2_key: `users/${uid}/captures/cap-1/1.webp`,
              mime_type: 'image/webp',
              byte_size: 12345,
              taken_at: null,
              width: 800,
              height: 600,
              caption: '캡처 사진'
            }
          ],
          field_memo: '메모',
          sponsorship: { is_sponsored: false },
          store_location_consent: false,
          llm_consent_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso
        }),
        nowIso,
        nowIso
      )
      .run();

    const token = await signFirebaseToken({ keyPair, sub: uid });

    // Manuscript download URLs
    const msRes = await SELF.fetch('https://worker.test/api/media/download-urls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ manuscript_id: 'ms-1' })
    });
    expect(msRes.status).toBe(200);
    const msJson = await msRes.json();
    const parsedMs = mediaDownloadUrlsResponseSchema.safeParse(msJson);
    expect(parsedMs.success).toBe(true);
    if (parsedMs.success) {
      expect(parsedMs.data.expires_in_seconds).toBe(600);
      expect(parsedMs.data.items).toHaveLength(1);
      expect(parsedMs.data.items[0]!.download_url).toContain('X-Amz-Expires=600');
      expect(parsedMs.data.items[0]!.download_url).toContain(`users/${uid}/captures/cap-1/1.webp`);
    }

    // Capture download URLs
    const capRes = await SELF.fetch('https://worker.test/api/media/download-urls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capture_id: 'cap-1' })
    });
    expect(capRes.status).toBe(200);
    const capJson = (await capRes.json()) as { items: Array<{ r2_key: string }> };
    expect(capJson.items[0]?.r2_key).toBe(`users/${uid}/captures/cap-1/1.webp`);

    // Missing R2_ACCOUNT_ID -> 503
    const workerModule = (await import('../src/index.js')).default;
    const missingCfgRes = await workerModule.fetch(
      new Request('https://worker.test/api/media/download-urls', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manuscript_id: 'ms-1' })
      }),
      { ...env, R2_ACCOUNT_ID: '' },
      {} as ExecutionContext
    );
    expect(missingCfgRes.status).toBe(503);
  });

  it('registers published posts for approved manuscripts only, extracts logNo, enforces (owner_uid, log_no) 409, and saves KST visitors', async () => {
    const nowIso = new Date().toISOString();
    const uid = 'owner-uid-1';
    const token = await signFirebaseToken({ keyPair, sub: uid });

    await seedCategoryTopicManuscript({
      ownerUid: uid,
      catId: 'cat-1',
      catName: '테크/IT',
      topicId: 'top-1',
      msId: 'ms-unapproved',
      approved: false,
      nowIso
    });
    await seedCategoryTopicManuscript({
      ownerUid: uid,
      catId: 'cat-1',
      catName: '테크/IT',
      topicId: 'top-2',
      msId: 'ms-approved',
      approved: true,
      nowIso
    });

    // Unapproved manuscript -> 422
    const unapprovedRes = await SELF.fetch('https://worker.test/api/published-posts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manuscript_id: 'ms-unapproved',
        post_url: 'https://blog.naver.com/myblog/223456789012',
        target_keywords: ['클라우드']
      })
    });
    expect(unapprovedRes.status).toBe(422);

    // Approved manuscript with path URL -> 201 + auto logNo + track_until (+30 days)
    const createRes = await SELF.fetch('https://worker.test/api/published-posts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manuscript_id: 'ms-approved',
        post_url: 'https://blog.naver.com/myblog/223456789012',
        target_keywords: ['클라우드플레어', 'D1 무료'],
        published_at: '2026-11-26T02:00:00.000Z'
      })
    });
    expect(createRes.status).toBe(201);
    const created = publishedPostResponseSchema.parse(await createRes.json());
    expect(created.post.log_no).toBe('223456789012');
    expect(created.post.track_until).toBe('2026-12-26');
    expect(created.post.target_keywords).toEqual(['클라우드플레어', 'D1 무료']);

    // Duplicate (owner_uid, log_no) -> 409 CONFLICT
    const dupRes = await SELF.fetch('https://worker.test/api/published-posts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manuscript_id: 'ms-approved',
        post_url: 'https://blog.naver.com/PostView.naver?blogId=myblog&logNo=223456789012',
        target_keywords: ['중복테스트']
      })
    });
    expect(dupRes.status).toBe(409);

    // List published posts
    const listRes = await SELF.fetch('https://worker.test/api/published-posts', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(listRes.status).toBe(200);
    const listParsed = publishedPostsListResponseSchema.parse(await listRes.json());
    expect(listParsed.posts).toHaveLength(1);

    // PUT & GET /api/visitors
    const putVis = await SELF.fetch('https://worker.test/api/visitors', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visit_date: '2026-11-26', visitor_count: 345 })
    });
    expect(putVis.status).toBe(200);
    const getVis = await SELF.fetch('https://worker.test/api/visitors', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(getVis.status).toBe(200);
    const visBody = (await getVis.json()) as { visitors: Array<{ visit_date: string; visitor_count: number }> };
    expect(visBody.visitors).toEqual([expect.objectContaining({ visit_date: '2026-11-26', visitor_count: 345 })]);
  });

  it('computes dashboard summary warnings (C-Rank, global quota without other-user leak, R2 80% cache & D1 fallback, 30-day backup)', async () => {
    const now = new Date();
    const nowIso = now.toISOString();
    const uid = 'owner-uid-1';
    const token = await signFirebaseToken({ keyPair, sub: uid });

    // Seed 5 approved manuscripts across 3 categories (2, 2, 1 -> top share 40% < 60% & 3 categories)
    await seedCategoryTopicManuscript({
      ownerUid: uid,
      catId: 'c1',
      catName: '테크/IT',
      topicId: 't1',
      msId: 'm1',
      approved: true,
      nowIso
    });
    await seedCategoryTopicManuscript({
      ownerUid: uid,
      catId: 'c1',
      catName: '테크/IT',
      topicId: 't2',
      msId: 'm2',
      approved: true,
      nowIso
    });
    await seedCategoryTopicManuscript({
      ownerUid: uid,
      catId: 'c2',
      catName: '맛집',
      topicId: 't3',
      msId: 'm3',
      approved: true,
      nowIso
    });
    await seedCategoryTopicManuscript({
      ownerUid: uid,
      catId: 'c2',
      catName: '맛집',
      topicId: 't4',
      msId: 'm4',
      approved: true,
      nowIso
    });
    await seedCategoryTopicManuscript({
      ownerUid: uid,
      catId: 'c3',
      catName: '여행',
      topicId: 't5',
      msId: 'm5',
      approved: true,
      nowIso
    });

    // Seed last_full_export_at = 35 days ago -> backup reminder due
    const oldExportIso = new Date(now.getTime() - 35 * 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_meta (owner_uid, key, value, updated_at)
         VALUES (?, 'last_full_export_at', ?, ?)`
      ).bind(uid, oldExportIso, oldExportIso),
      // Seed other user's usage_daily to ensure it NEVER leaks into dashboard summary
      env.DB.prepare(
        `INSERT INTO usage_daily (owner_uid, provider, window_date, calls)
         VALUES ('secret-other-user-xyz', 'naver_search', '2026-11-26', 99)`
      ),
      // Seed captures for initial D1 fallback test (when app_meta.r2_usage_bytes is absent)
      env.DB.prepare(
        `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
         VALUES ('cap-fb', ?, 'c1', 'experience_review', NULL, ?, ?, ?)`
      ).bind(
        uid,
        JSON.stringify({ photos: [{ byte_size: 500_000 }] }),
        nowIso,
        nowIso
      )
    ]);

    // 1) Initial call: D1 fallback for R2 usage, C-Rank fallback to approved_manuscripts (warning=true), backup reminder=true
    const res1 = await SELF.fetch('https://worker.test/api/dashboard/summary', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(res1.status).toBe(200);
    const raw1 = await res1.json();
    const summary1 = dashboardSummaryResponseSchema.parse(raw1);
    expect(summary1.approvals.today_count).toBe(5);
    expect(summary1.c_rank.basis).toBe('approved_manuscripts');
    expect(summary1.c_rank.total_count).toBe(5);
    expect(summary1.c_rank.category_count).toBe(3);
    expect(summary1.c_rank.warning).toBe(true);
    expect(summary1.r2_usage.source).toBe('d1_fallback');
    expect(summary1.r2_usage.used_bytes).toBe(500_000);
    expect(summary1.r2_usage.warning).toBe(false);
    expect(summary1.backup.reminder_due).toBe(true);
    expect(summary1.backup.days_since_export).toBeGreaterThanOrEqual(35);
    // Must never leak other user's UID or per-user usage
    expect(JSON.stringify(raw1)).not.toContain('secret-other-user-xyz');

    // 2) Set app_meta.r2_usage_bytes >= 80% of 10GiB + trigger POST /api/export -> R2 warning=true, backup reminder cleared
    const over80Bytes = Math.ceil(R2_FREE_LIMIT_BYTES * 0.82);
    await env.DB.prepare(
      `INSERT INTO app_meta (key, value, updated_at) VALUES ('r2_usage_bytes', ?, ?)`
    )
      .bind(String(over80Bytes), nowIso)
      .run();

    const exportRes = await SELF.fetch('https://worker.test/api/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(exportRes.status).toBe(200);

    const res2 = await SELF.fetch('https://worker.test/api/dashboard/summary', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const summary2 = dashboardSummaryResponseSchema.parse(await res2.json());
    expect(summary2.r2_usage.source).toBe('r2_scan_cache');
    expect(summary2.r2_usage.warning).toBe(true);
    expect(summary2.backup.reminder_due).toBe(false);
    expect(summary2.backup.days_since_export).toBe(0);
  });

  it('reads, updates, clears, and validates naver_blog_id in GET/PUT /api/settings', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });

    const initial = await SELF.fetch('https://worker.test/api/settings', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(initial.status).toBe(200);
    expect(settingsResponseSchema.parse(await initial.json()).naver_blog_id).toBeNull();

    // Reject URL injection
    const bad = await SELF.fetch('https://worker.test/api/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ naver_blog_id: 'https://evil.com/phish' })
    });
    expect(bad.status).toBe(400);

    // Save valid blog ID
    const saved = await SELF.fetch('https://worker.test/api/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ naver_blog_id: 'my_blog-2026' })
    });
    expect(saved.status).toBe(200);
    expect(settingsResponseSchema.parse(await saved.json()).naver_blog_id).toBe('my_blog-2026');

    // Clear blog ID
    const cleared = await SELF.fetch('https://worker.test/api/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ naver_blog_id: null })
    });
    expect(cleared.status).toBe(200);
    expect(settingsResponseSchema.parse(await cleared.json()).naver_blog_id).toBeNull();
  });
});
