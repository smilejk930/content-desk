import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSourceSnapshotResponseSchema,
  discoverStep1ResponseSchema,
  discoverStep2ResponseSchema,
  discoverStep3ResponseSchema,
  MAX_SNAPSHOT_BODY_BYTES,
  topicResponseSchema,
  topicSourceCandidatesResponseSchema
} from '@content-desk/shared';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-topics-test');
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
});

async function seedTrendCategory(): Promise<string> {
  const nowIso = new Date().toISOString();
  const catId = 'cat-tech-trend';
  await env.DB.prepare(
    `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
     VALUES (?, 'owner-uid-1', '테크/IT', 'trend_first', '클라우드', '전체공개', ?, ?, ?)`
  )
    .bind(
      catId,
      JSON.stringify({
        category_id: catId,
        display_name: '테크/IT',
        naver_board_name: 'IT해설',
        discovery_mode: 'trend_first',
        datalab_anchor_keyword: '클라우드',
        seed_keywords: ['Cloudflare Workers', '주식 추천'],
        primary_source_domains: ['developers.cloudflare.com'],
        default_media_policy: {
          allowed_content_types: ['explainer', 'experience_review'],
          min_real_photos: 0,
          require_field_memo: false
        },
        default_visibility: '전체공개',
        created_at: nowIso,
        updated_at: nowIso
      }),
      nowIso,
      nowIso
    )
    .run();
  return catId;
}

describe('글감 4단계 발굴 · 1차 출처 후보/스냅샷 · SSRF/robots.txt/50KB/도메인 경고 (/api/topics)', () => {
  it('executes Steps 1->2->3 with Google Trends 429 backoff fallback, DataLab 24h caching, YMYL batch confirm, and optional SearchAd', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const categoryId = await seedTrendCategory();
    let datalabCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url.includes('trends.google.com/trending/rss')) {
        return new Response('Too Many Requests', { status: 429 });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify([
                        { keyword: 'Cloudflare Workers', verdict: 'SAFE', reason: '일반 IT 주제' },
                        {
                          keyword: '건강한 개발 습관',
                          verdict: 'BORDERLINE',
                          reason: '건강 표현 경계 사례'
                        }
                      ])
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('openapi.naver.com/v1/datalab/search')) {
        datalabCalls += 1;
        const reqBody = JSON.parse(String(init?.body ?? '{}')) as {
          keywordGroups: Array<{ groupName: string }>;
        };
        expect(reqBody.keywordGroups.length).toBeLessThanOrEqual(5);
        expect(reqBody.keywordGroups[0]?.groupName).toBe('__anchor__');
        return new Response(
          JSON.stringify({
            results: reqBody.keywordGroups.map((g) => ({
              title: g.groupName,
              data: [{ period: '2026-11-01', ratio: g.groupName === '__anchor__' ? 50 : 75 }]
            }))
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('openapi.naver.com/v1/search/blog.json')) {
        return new Response(
          JSON.stringify({
            total: 1200,
            items: [
              {
                title: '<b>Cloudflare Workers</b> 정리',
                link: 'https://blog.naver.com/demo/1',
                description: '서버리스 엣지 런타임 정리 스니펫'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('openapi.naver.com/v1/search/news.json')) {
        return new Response(
          JSON.stringify({
            total: 45,
            items: [
              {
                title: '클라우드플레어 신규 발표',
                link: 'https://news.example.com/1',
                description: '무료 티어 업데이트 소식'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // Step 1: seeds + Google Trends 429 fallback + YMYL 2-stage batch
    const step1Res = await SELF.fetch('https://worker.test/api/topics/discover/step1-seeds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: categoryId,
        content_type: 'explainer',
        extra_keywords: ['건강한 개발 습관'],
        include_google_trends: true
      })
    });
    expect(step1Res.status).toBe(201);
    const step1 = discoverStep1ResponseSchema.parse(await step1Res.json());
    expect(step1.google_trends_status).toBe('backoff_skipped');
    expect(step1.blocked_keywords).toHaveLength(1);
    expect(step1.blocked_keywords[0]?.keyword).toBe('주식 추천');
    expect(step1.topics).toHaveLength(2);

    const borderlineTopic = step1.topics.find((t) => t.keyword === '건강한 개발 습관')!;
    expect(borderlineTopic.ymyl_status).toBe('BORDERLINE_PENDING');

    // Confirm borderline topic via POST /api/topics/:id/ymyl-confirm
    const confirmRes = await SELF.fetch(
      `https://worker.test/api/topics/${borderlineTopic.topic_id}/ymyl-confirm`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }
    );
    expect(confirmRes.status).toBe(200);
    expect(topicResponseSchema.parse(await confirmRes.json()).topic.ymyl_status).toBe(
      'BORDERLINE_CONFIRMED'
    );

    // Step 2: DataLab anchor normalization (first call -> API, second call -> 24h cache hit!)
    const step2First = await SELF.fetch('https://worker.test/api/topics/discover/step2-datalab', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: step1.run_id })
    });
    expect(step2First.status).toBe(200);
    const s2FirstJson = discoverStep2ResponseSchema.parse(await step2First.json());
    expect(s2FirstJson.api_calls).toBe(1);
    expect(s2FirstJson.cache_hits).toBe(0);
    expect(s2FirstJson.topics[0]?.datalab_demand_index).toBe(150);

    const step2Second = await SELF.fetch('https://worker.test/api/topics/discover/step2-datalab', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: step1.run_id })
    });
    expect(step2Second.status).toBe(200);
    const s2SecondJson = discoverStep2ResponseSchema.parse(await step2Second.json());
    expect(s2SecondJson.api_calls).toBe(0);
    expect(s2SecondJson.cache_hits).toBe(2);
    expect(datalabCalls).toBe(1);

    // Step 3: Supply collection (SearchAd keys unset -> searchad_used: false)
    const step3Res = await SELF.fetch('https://worker.test/api/topics/discover/step3-supply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: step1.run_id })
    });
    expect(step3Res.status).toBe(200);
    const step3 = discoverStep3ResponseSchema.parse(await step3Res.json());
    expect(step3.searchad_used).toBe(false);
    expect(step3.topics[0]?.blog_supply_count).toBe(1200);
    expect(step3.topics[0]?.news_supply_count).toBe(45);
    expect(step3.topics[0]?.serp_snippets?.length).toBeGreaterThan(0);
  });

  it('filters Step 4 webkr candidates by strict domain suffix, enforces unlisted domain 409 confirm, SSRF guard, robots.txt, and 50KB HTMLRewriter R2 snapshot', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const categoryId = await seedTrendCategory();
    const nowIso = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
       VALUES ('topic-src-1', 'owner-uid-1', 'run-src', 'category_discovery', ?, 'explainer', 'SUPPLY_SCORED', 'SAFE', ?, ?, ?)`
    )
      .bind(
        categoryId,
        JSON.stringify({
          topic_id: 'topic-src-1',
          run_id: 'run-src',
          track: 'category_discovery',
          category_id: categoryId,
          content_type: 'explainer',
          status: 'SUPPLY_SCORED',
          keyword: '클라우드플레어 D1',
          capture_ids: [],
          sources: [],
          ymyl_status: 'SAFE',
          sponsorship: { is_sponsored: false },
          datalab_demand_index: 80,
          blog_supply_count: 100,
          news_supply_count: 10,
          monthly_search_volume: null,
          competition_score: null,
          created_at: nowIso
        }),
        nowIso,
        nowIso
      )
      .run();

    const oversizedBody = '공식 문서 본문 테스트입니다. '.repeat(4000); // > 50KB UTF-8

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url.includes('openapi.naver.com/v1/search/webkr.json')) {
        return new Response(
          JSON.stringify({
            total: 4,
            items: [
              {
                title: '과기정통부 보도자료',
                link: 'https://www.msit.go.kr/press/123',
                description: '공식 보도자료'
              },
              {
                title: '사칭 도메인 1',
                link: 'https://evilgo.kr/fake',
                description: '차단되어야 함'
              },
              {
                title: '사칭 도메인 2',
                link: 'https://go.kr.evil.com/fake',
                description: '차단되어야 함'
              },
              {
                title: 'Cloudflare 공식 문서',
                link: 'https://developers.cloudflare.com/d1/limits',
                description: 'D1 공식 한도'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'https://www.msit.go.kr/robots.txt') {
        return new Response('User-agent: *\nDisallow: /private/\nAllow: /press/\n', { status: 200 });
      }
      if (url === 'https://www.msit.go.kr/private/secret') {
        return new Response('<html><body>Secret</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        });
      }
      if (url === 'https://www.msit.go.kr/press/123') {
        return new Response(
          `<html><head><style>body{color:red}</style><script>alert("xss")</script></head><body><nav>메뉴</nav><main><p>${oversizedBody}</p></main></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }
      if (url === 'https://unlisted-vendor.example/robots.txt') {
        return new Response('', { status: 404 });
      }
      if (url === 'https://unlisted-vendor.example/spec') {
        return new Response('<html><body><article><p>공식 벤더 스펙 128GB 지원</p></article></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // 1) webkr candidates must include go.kr + developers.cloudflare.com and exclude spoofed domains
    const candRes = await SELF.fetch('https://worker.test/api/topics/topic-src-1/sources/candidates', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(candRes.status).toBe(200);
    const candJson = topicSourceCandidatesResponseSchema.parse(await candRes.json());
    expect(candJson.candidates.map((c) => c.domain)).toEqual([
      'www.msit.go.kr',
      'developers.cloudflare.com'
    ]);

    // 2) SSRF guard blocks loopback, metadata IP, private IP
    for (const ssrfUrl of [
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/internal',
      'http://localhost:8787/api/health',
      'http://[::1]/secret'
    ]) {
      const ssrfRes = await SELF.fetch('https://worker.test/api/topics/topic-src-1/sources/snapshot', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ssrfUrl,
          ingest_channel: 'manual_input',
          confirm_unlisted_domain: true
        })
      });
      expect(ssrfRes.status).toBe(422);
      expect(((await ssrfRes.json()) as { error: { code: string } }).error.code).toBe('SSRF_BLOCKED');
    }

    // 3) robots.txt Disallow blocks /private/secret with 422 ROBOTS_DISALLOWED
    const robotsRes = await SELF.fetch('https://worker.test/api/topics/topic-src-1/sources/snapshot', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.msit.go.kr/private/secret',
        ingest_channel: 'manual_input',
        confirm_unlisted_domain: false
      })
    });
    expect(robotsRes.status).toBe(422);
    expect(((await robotsRes.json()) as { error: { code: string } }).error.code).toBe(
      'ROBOTS_DISALLOWED'
    );

    // 4) Allowed domain snapshot -> strips script/style/nav, truncates to <= 50KB in R2, sets topic READY
    const snapRes = await SELF.fetch('https://worker.test/api/topics/topic-src-1/sources/snapshot', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.msit.go.kr/press/123',
        ingest_channel: 'webkr_search',
        confirm_unlisted_domain: false
      })
    });
    expect(snapRes.status).toBe(201);
    const snapJson = createSourceSnapshotResponseSchema.parse(await snapRes.json());
    expect(snapJson.topic.status).toBe('READY');
    expect(snapJson.snapshot.r2_key).toMatch(
      /^users\/owner-uid-1\/snapshots\/topic-src-1\/.+\.txt$/
    );

    const r2Obj = await env.MEDIA_BUCKET.get(snapJson.snapshot.r2_key);
    expect(r2Obj).not.toBeNull();
    const storedText = await r2Obj!.text();
    expect(new TextEncoder().encode(storedText).byteLength).toBeLessThanOrEqual(
      MAX_SNAPSHOT_BODY_BYTES
    );
    expect(storedText).not.toContain('alert("xss")');
    expect(storedText).not.toContain('메뉴');
    expect(storedText).toContain('공식 문서 본문 테스트입니다.');

    // 5) Unlisted domain: 1st request returns 409 SOURCE_DOMAIN_CONFIRM_REQUIRED; 2nd with confirm=true succeeds
    const unlistedFirst = await SELF.fetch(
      'https://worker.test/api/topics/topic-src-1/sources/snapshot',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://unlisted-vendor.example/spec',
          ingest_channel: 'manual_input',
          confirm_unlisted_domain: false
        })
      }
    );
    expect(unlistedFirst.status).toBe(409);
    expect(((await unlistedFirst.json()) as { error: { code: string } }).error.code).toBe(
      'SOURCE_DOMAIN_CONFIRM_REQUIRED'
    );

    const unlistedConfirm = await SELF.fetch(
      'https://worker.test/api/topics/topic-src-1/sources/snapshot',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://unlisted-vendor.example/spec',
          ingest_channel: 'manual_input',
          confirm_unlisted_domain: true
        })
      }
    );
    expect(unlistedConfirm.status).toBe(201);
    const confirmedJson = createSourceSnapshotResponseSchema.parse(await unlistedConfirm.json());
    expect(confirmedJson.snapshot.domain).toBe('unlisted-vendor.example');
    expect(confirmedJson.topic.sources).toHaveLength(2);
  });

  it('rejects step2-datalab and step3-supply for from-capture vlog run_id with 0 external fetches and 0 api_cache writes', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const nowIso = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('cat-vlog-guard', 'owner-uid-1', '일상브이로그', 'none', NULL, '이웃공개', ?, ?, ?)`
      ).bind(
        JSON.stringify({
          category_id: 'cat-vlog-guard',
          display_name: '일상브이로그',
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
         VALUES ('cap-vlog-guard', 'owner-uid-1', 'cat-vlog-guard', 'vlog', ?, ?, ?, ?)`
      ).bind(
        nowIso,
        JSON.stringify({
          capture_id: 'cap-vlog-guard',
          category_id: 'cat-vlog-guard',
          content_type: 'vlog',
          photos: [],
          field_memo: '한강 공원 산책 브이로그',
          sponsorship: { is_sponsored: false },
          store_location_consent: false,
          llm_consent_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso
        }),
        nowIso,
        nowIso
      )
    ]);

    let externalNaverCalls = 0;
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
            candidates: [{ content: { parts: [{ text: '{"verdict":"SAFE","reason":"일상"}' }] } }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      externalNaverCalls += 1;
      throw new Error(`External fetch must not be called for vlog step2/step3: ${url}`);
    });

    // Create vlog topic via from-capture
    const fromCapRes = await SELF.fetch('https://worker.test/api/topics/from-capture', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capture_id: 'cap-vlog-guard' })
    });
    expect(fromCapRes.status).toBe(201);
    const { topic: vlogTopic } = topicResponseSchema.parse(await fromCapRes.json());

    // Attempt step2-datalab with vlog run_id -> 422 rejected, 0 external fetches, 0 api_cache
    const step2Blocked = await SELF.fetch('https://worker.test/api/topics/discover/step2-datalab', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: vlogTopic.run_id })
    });
    expect(step2Blocked.status).toBe(422);

    // Attempt step3-supply with vlog run_id -> 422 rejected, 0 external fetches, 0 api_cache
    const step3Blocked = await SELF.fetch('https://worker.test/api/topics/discover/step3-supply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: vlogTopic.run_id })
    });
    expect(step3Blocked.status).toBe(422);

    expect(externalNaverCalls).toBe(0);
    const cacheCount = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM api_cache').first<{
      cnt: number;
    }>();
    expect(cacheCount?.cnt).toBe(0);
  });

  it('enforces redirect domain re-check (409), MIME/stream cancel limits, RFC 9309 robots.txt (redirect/5xx/wildcard/finalUrl), IPv6/port SSRF, source cap 10, optimistic lock + R2 cleanup, and SearchAd 401 fallback', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const categoryId = await seedTrendCategory();
    const nowIso = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
       VALUES ('topic-hardened', 'owner-uid-1', 'run-hardened', 'category_discovery', ?, 'explainer', 'SUPPLY_SCORED', 'SAFE', ?, ?, ?)`
    )
      .bind(
        categoryId,
        JSON.stringify({
          topic_id: 'topic-hardened',
          run_id: 'run-hardened',
          track: 'category_discovery',
          category_id: categoryId,
          content_type: 'explainer',
          status: 'SUPPLY_SCORED',
          keyword: '보안 검증',
          capture_ids: [],
          sources: [],
          ymyl_status: 'SAFE',
          sponsorship: { is_sponsored: false },
          datalab_demand_index: 50,
          blog_supply_count: 10,
          news_supply_count: 2,
          monthly_search_volume: null,
          competition_score: null,
          created_at: nowIso
        }),
        nowIso,
        nowIso
      )
      .run();

    let streamCanceled = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      // 1) Open redirect from allowed go.kr to unlisted domain -> must 409 SOURCE_DOMAIN_CONFIRM_REQUIRED
      if (url === 'https://open.go.kr/robots.txt') {
        return new Response('', { status: 404 });
      }
      if (url === 'https://open.go.kr/redirect') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil-unlisted.example/landing' }
        });
      }
      // 2) PDF binary response rejected with 422
      if (url === 'https://pdf.go.kr/robots.txt') {
        return new Response('', { status: 404 });
      }
      if (url === 'https://pdf.go.kr/doc.pdf') {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { 'content-type': 'application/pdf' }
        });
      }
      // 3) Huge streaming response without Content-Length -> reader.cancel() called immediately
      if (url === 'https://huge.go.kr/robots.txt') {
        return new Response('', { status: 404 });
      }
      if (url === 'https://huge.go.kr/stream') {
        let emitted = 0;
        const bigStream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (emitted > 30) {
              controller.close();
              return;
            }
            emitted += 1;
            controller.enqueue(new Uint8Array(128 * 1024)); // 128KB per chunk -> exceeds 1.5MB quickly
          },
          cancel() {
            streamCanceled = true;
          }
        });
        return new Response(bigStream, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }
      // 4) robots.txt 5xx -> fail closed (422 ROBOTS_DISALLOWED)
      if (url === 'https://err500.go.kr/robots.txt') {
        return new Response('Internal Error', { status: 503 });
      }
      // 5) robots.txt 301 redirect + wildcard (*) & end anchor ($) + same-origin path redirect re-check
      if (url === 'https://redir.go.kr/robots.txt') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://www.redir.go.kr/robots.txt' }
        });
      }
      if (url === 'https://www.redir.go.kr/robots.txt') {
        return new Response(
          'User-agent: *\nDisallow: /docs/*.secret$\nDisallow: /blocked-final/\n',
          { status: 200, headers: { 'content-type': 'text/plain' } }
        );
      }
      if (url === 'https://redir.go.kr/public-entry') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://redir.go.kr/blocked-final/page' }
        });
      }
      if (url === 'https://redir.go.kr/blocked-final/page') {
        return new Response('<html><body>Secret final</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // Minor 5: Non-80/443 port and any IPv6 literal blocked
    for (const badUrl of [
      'https://www.msit.go.kr:8443/press',
      'http://[2001:4860:4860::8888]/'
    ]) {
      const res = await SELF.fetch('https://worker.test/api/topics/topic-hardened/sources/snapshot', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: badUrl, ingest_channel: 'manual_input', confirm_unlisted_domain: true })
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SSRF_BLOCKED');
    }

    // Recommended 1: Open redirect from go.kr -> unlisted domain must 409
    const openRedirectRes = await SELF.fetch(
      'https://worker.test/api/topics/topic-hardened/sources/snapshot',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://open.go.kr/redirect',
          ingest_channel: 'webkr_search',
          confirm_unlisted_domain: false
        })
      }
    );
    expect(openRedirectRes.status).toBe(409);
    expect(((await openRedirectRes.json()) as { error: { code: string } }).error.code).toBe(
      'SOURCE_DOMAIN_CONFIRM_REQUIRED'
    );

    // Recommended 2: PDF MIME rejected with 422
    const pdfRes = await SELF.fetch(
      'https://worker.test/api/topics/topic-hardened/sources/snapshot',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://pdf.go.kr/doc.pdf', ingest_channel: 'manual_input' })
      }
    );
    expect(pdfRes.status).toBe(422);

    // Recommended 2: Oversized stream triggers reader.cancel() and rejects 422
    const hugeRes = await SELF.fetch(
      'https://worker.test/api/topics/topic-hardened/sources/snapshot',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://huge.go.kr/stream', ingest_channel: 'manual_input' })
      }
    );
    expect(hugeRes.status).toBe(422);
    expect(streamCanceled).toBe(true);

    // Recommended 3: robots.txt 503 fails closed with 422 ROBOTS_DISALLOWED
    const robots503Res = await SELF.fetch(
      'https://worker.test/api/topics/topic-hardened/sources/snapshot',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://err500.go.kr/page', ingest_channel: 'manual_input' })
      }
    );
    expect(robots503Res.status).toBe(422);
    expect(((await robots503Res.json()) as { error: { code: string } }).error.code).toBe(
      'ROBOTS_DISALLOWED'
    );

    // Recommended 3: robots.txt wildcard * & $ anchor via 301 redirect blocks /docs/abc.secret
    const wildcardBlocked = await SELF.fetch(
      'https://worker.test/api/topics/topic-hardened/sources/snapshot',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://redir.go.kr/docs/abc.secret',
          ingest_channel: 'manual_input'
        })
      }
    );
    expect(wildcardBlocked.status).toBe(422);
    expect(((await wildcardBlocked.json()) as { error: { code: string } }).error.code).toBe(
      'ROBOTS_DISALLOWED'
    );

    // Recommended 3: same-origin redirect to disallowed path (/public-entry -> /blocked-final/page) re-checks robots.txt
    const sameOriginRedirectBlocked = await SELF.fetch(
      'https://worker.test/api/topics/topic-hardened/sources/snapshot',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://redir.go.kr/public-entry',
          ingest_channel: 'manual_input'
        })
      }
    );
    expect(sameOriginRedirectBlocked.status).toBe(422);
    expect(
      ((await sameOriginRedirectBlocked.json()) as { error: { code: string } }).error.code
    ).toBe('ROBOTS_DISALLOWED');

    // Recommended 4: Max 10 sources cap -> 422 when already at 10 sources
    const tenSources = Array.from({ length: 10 }, (_, idx) => ({
      source_id: `s-${idx + 1}`,
      url: `https://www.msit.go.kr/p/${idx + 1}`,
      domain: 'www.msit.go.kr',
      r2_key: `users/owner-uid-1/snapshots/topic-hardened/s-${idx + 1}.txt`,
      fetched_at: nowIso,
      body_sha256: 'a'.repeat(64),
      ingest_channel: 'manual_input' as const
    }));
    await env.DB.prepare(
      `UPDATE topics SET topic_json = ? WHERE owner_uid = 'owner-uid-1' AND topic_id = 'topic-hardened'`
    )
      .bind(
        JSON.stringify({
          topic_id: 'topic-hardened',
          run_id: 'run-hardened',
          track: 'category_discovery',
          category_id: categoryId,
          content_type: 'explainer',
          status: 'READY',
          keyword: '보안 검증',
          capture_ids: [],
          sources: tenSources,
          ymyl_status: 'SAFE',
          sponsorship: { is_sponsored: false },
          datalab_demand_index: 50,
          blog_supply_count: 10,
          news_supply_count: 2,
          monthly_search_volume: null,
          competition_score: null,
          created_at: nowIso
        })
      )
      .run();

    const capExceededRes = await SELF.fetch(
      'https://worker.test/api/topics/topic-hardened/sources/snapshot',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://www.msit.go.kr/p/11',
          ingest_channel: 'manual_input'
        })
      }
    );
    expect(capExceededRes.status).toBe(422);

    // Recommended 5 + Minor 1: SearchAd 401 failure gracefully skips without 500, searchad_used=false, usage_daily unchanged
    const workerModule = (await import('../src/index.js')).default;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO execution_runs (run_id, owner_uid, kind, status, state_json, created_at, updated_at)
         VALUES ('run-sad', 'owner-uid-1', 'topic_discovery', 'STEP2_DATALAB_DONE', '{}', ?, ?)`
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
         VALUES ('topic-sad', 'owner-uid-1', 'run-sad', 'category_discovery', ?, 'explainer', 'DATALAB_SCORED', 'SAFE', ?, ?, ?)`
      ).bind(
        categoryId,
        JSON.stringify({
          topic_id: 'topic-sad',
          run_id: 'run-sad',
          track: 'category_discovery',
          category_id: categoryId,
          content_type: 'explainer',
          status: 'DATALAB_SCORED',
          keyword: '검색광고폴백',
          capture_ids: [],
          sources: [],
          ymyl_status: 'SAFE',
          sponsorship: { is_sponsored: false },
          datalab_demand_index: 60,
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

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url.includes('api.searchad.naver.com/keywordstool')) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (url.includes('openapi.naver.com/v1/search/')) {
        return new Response(JSON.stringify({ total: 10, items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const sadStep3 = await workerModule.fetch(
      new Request('https://worker.test/api/topics/discover/step3-supply', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: 'run-sad' })
      }),
      {
        ...env,
        NAVER_SEARCHAD_API_KEY: 'bad-key',
        NAVER_SEARCHAD_SECRET_KEY: 'bad-secret',
        NAVER_SEARCHAD_CUSTOMER_ID: '12345'
      },
      {} as ExecutionContext
    );
    expect(sadStep3.status).toBe(200);
    const sadJson = discoverStep3ResponseSchema.parse(await sadStep3.json());
    expect(sadJson.searchad_used).toBe(false);

    const sadUsage = await env.DB.prepare(
      `SELECT calls FROM usage_daily WHERE owner_uid = 'owner-uid-1' AND provider = 'naver_searchad'`
    ).first<{ calls: number }>();
    expect(sadUsage).toBeNull();
  });

  it('picks strictest verdict (BLOCKED > BORDERLINE > SAFE) on duplicate YMYL batch keywords and returns 409 on cross-user run_id conflict', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const categoryId = await seedTrendCategory();
    const nowIso = new Date().toISOString();

    // Seed another user's run_id in execution_runs
    await env.DB.prepare(
      `INSERT INTO execution_runs (run_id, owner_uid, kind, status, state_json, created_at, updated_at)
       VALUES ('shared-run-collision', 'other-owner-999', 'topic_discovery', 'STEP1_SEEDS_DONE', '{}', ?, ?)`
    )
      .bind(nowIso, nowIso)
      .run();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        // Duplicate keyword with BLOCKED first and SAFE second -> BLOCKED must win!
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify([
                        { keyword: 'Cloudflare Workers', verdict: 'BLOCKED', reason: '차단 테스트' },
                        { keyword: 'Cloudflare Workers', verdict: 'SAFE', reason: '뒤늦은 SAFE 덮어쓰기 시도' }
                      ])
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

    // Duplicate keyword -> BLOCKED wins
    const dupVerdictRes = await SELF.fetch('https://worker.test/api/topics/discover/step1-seeds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: categoryId,
        content_type: 'explainer',
        include_google_trends: false
      })
    });
    expect(dupVerdictRes.status).toBe(201);
    const dupJson = discoverStep1ResponseSchema.parse(await dupVerdictRes.json());
    expect(dupJson.topics).toHaveLength(0);
    expect(dupJson.blocked_keywords.some((b) => b.keyword === 'Cloudflare Workers')).toBe(true);

    // Cross-user run_id collision -> 409 CONFLICT
    const collisionRes = await SELF.fetch('https://worker.test/api/topics/discover/step1-seeds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: categoryId,
        content_type: 'explainer',
        include_google_trends: false,
        run_id: 'shared-run-collision'
      })
    });
    expect(collisionRes.status).toBe(409);
    expect(((await collisionRes.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('returns 409 on optimistic lock updated_at conflict during sources/snapshot and performs R2 compensation delete', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const categoryId = await seedTrendCategory();
    const nowIso = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
       VALUES ('topic-race', 'owner-uid-1', 'run-race', 'category_discovery', ?, 'explainer', 'SUPPLY_SCORED', 'SAFE', ?, ?, ?)`
    )
      .bind(
        categoryId,
        JSON.stringify({
          topic_id: 'topic-race',
          run_id: 'run-race',
          track: 'category_discovery',
          category_id: categoryId,
          content_type: 'explainer',
          status: 'SUPPLY_SCORED',
          keyword: '낙관적 잠금 테스트',
          capture_ids: [],
          sources: [],
          ymyl_status: 'SAFE',
          sponsorship: { is_sponsored: false },
          datalab_demand_index: 50,
          blog_supply_count: 10,
          news_supply_count: 2,
          monthly_search_volume: null,
          competition_score: null,
          created_at: nowIso
        }),
        nowIso,
        nowIso
      )
      .run();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url === 'https://race.go.kr/robots.txt') {
        return new Response('', { status: 404 });
      }
      if (url === 'https://race.go.kr/doc') {
        // Simulate concurrent modification bumping updated_at before D1 commit
        await env.DB.prepare(
          `UPDATE topics SET updated_at = '2099-01-01T00:00:00.000Z' WHERE topic_id = 'topic-race'`
        ).run();
        return new Response('<html><body><p>공식 문서 본문입니다.</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const raceRes = await SELF.fetch('https://worker.test/api/topics/topic-race/sources/snapshot', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://race.go.kr/doc', ingest_channel: 'manual_input' })
    });
    expect(raceRes.status).toBe(409);
    expect(((await raceRes.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');

    // Verify 0 orphan D1 source_snapshots rows and 0 orphan R2 objects
    const snapCount = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM source_snapshots WHERE topic_id = 'topic-race'`
    ).first<{ cnt: number }>();
    expect(snapCount?.cnt).toBe(0);

    const listed = await env.MEDIA_BUCKET.list({
      prefix: 'users/owner-uid-1/snapshots/topic-race/'
    });
    expect(listed.objects).toHaveLength(0);
  });
});
