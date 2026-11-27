import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  manuscriptDetailResponseSchema,
  manuscriptResponseSchema,
  verifySanitizeResponseSchema
} from '@content-desk/shared';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-manuscript-gate');
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
    env.DB.prepare('DELETE FROM users')
  ]);
  vi.restoreAllMocks();
});

async function seedExplainerTopicWithSnapshot() {
  const nowIso = new Date().toISOString();
  const r2Key = 'users/owner-uid-1/snapshots/topic-exp-1/snap-1.txt';
  const snapshotText =
    'Cloudflare D1 무료 플랜은 일일 읽기 500만 행과 일일 쓰기 10만 행, 데이터베이스당 500MB 저장 용량을 제공합니다.';

  await env.MEDIA_BUCKET.put(r2Key, new TextEncoder().encode(snapshotText), {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' }
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
       VALUES ('cat-exp', 'owner-uid-1', '테크/IT', 'trend_first', '클라우드', '전체공개', ?, ?, ?)`
    ).bind(
      JSON.stringify({
        category_id: 'cat-exp',
        display_name: '테크/IT',
        naver_board_name: 'IT해설',
        discovery_mode: 'trend_first',
        datalab_anchor_keyword: '클라우드',
        seed_keywords: ['D1'],
        primary_source_domains: ['developers.cloudflare.com'],
        default_media_policy: {
          allowed_content_types: ['explainer'],
          min_real_photos: 0,
          require_field_memo: false
        },
        default_visibility: '전체공개',
        created_at: nowIso,
        updated_at: nowIso
      }),
      nowIso,
      nowIso
    ),
    env.DB.prepare(
      `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
       VALUES ('topic-exp-1', 'owner-uid-1', 'run-exp', 'category_discovery', 'cat-exp', 'explainer', 'READY', 'SAFE', ?, ?, ?)`
    ).bind(
      JSON.stringify({
        topic_id: 'topic-exp-1',
        run_id: 'run-exp',
        track: 'category_discovery',
        category_id: 'cat-exp',
        content_type: 'explainer',
        status: 'READY',
        keyword: 'Cloudflare D1 한도',
        capture_ids: [],
        sources: [
          {
            source_id: 'snap-1',
            url: 'https://developers.cloudflare.com/d1/platform/limits/',
            domain: 'developers.cloudflare.com',
            r2_key: r2Key,
            fetched_at: nowIso,
            body_sha256: 'a'.repeat(64),
            ingest_channel: 'webkr_search',
            char_count: snapshotText.length
          }
        ],
        ymyl_status: 'SAFE',
        sponsorship: { is_sponsored: false },
        datalab_demand_index: 90,
        blog_supply_count: 50,
        news_supply_count: 3,
        monthly_search_volume: null,
        competition_score: null,
        serp_snippets: [{ title: 'D1 정리', snippet: 'D1 무료 한도 요약', source: 'blog' }],
        created_at: nowIso
      }),
      nowIso,
      nowIso
    )
  ]);
}

describe('원고 생성·대조/정제·[VERIFY] 차단·해소·승인·수정 시 승인 해제 (/api/manuscripts)', () => {
  it('runs 2-request generate -> verify-sanitize, strips XSS/unlisted links, blocks approval until [VERIFY] resolved, and clears approval on PATCH', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    await seedExplainerTopicWithSnapshot();

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
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify({ verdict: 'SAFE', reason: '비YMYL 기술 문서' }) }]
                  }
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }

        // Draft response containing: 1 verified claim, 1 fabricated numeric claim, XSS script, allowed & disallowed links
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title_candidates: ['Cloudflare D1 무료 한도 총정리', 'D1 시작 가이드'],
                        selected_title: 'Cloudflare D1 무료 한도 총정리',
                        body_html:
                          '<h2 onclick="alert(1)">D1 무료 플랜 한도</h2>' +
                          '<script>evil()</script>' +
                          '<p>데이터베이스당 500MB 저장 용량을 제공합니다. ' +
                          '<a href="https://developers.cloudflare.com/d1/platform/limits/" target="_blank">공식 문서</a> ' +
                          '<a href="https://evil.example/phish">악성 링크</a></p>' +
                          '<p>월 유료 비용은 99,000원입니다.</p>',
                        tags: ['Cloudflare', 'D1'],
                        claims: [
                          {
                            claim: '데이터베이스당 500MB 저장 용량을 제공합니다.',
                            source_id: 'snap-1',
                            quote: '데이터베이스당 500MB 저장 용량을 제공합니다.'
                          },
                          {
                            claim: '월 유료 비용은 99,000원입니다.',
                            source_id: 'snap-1',
                            quote: '일일 쓰기 10만 행'
                          }
                        ]
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

    // Request 1: generate — must sanitize body_html on save and leave sanitized_at === null
    const genRes = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-exp-1' })
    });
    expect(genRes.status).toBe(201);
    const genJson = manuscriptResponseSchema.parse(await genRes.json());
    const manuscriptId = genJson.manuscript.manuscript_id;
    expect(genJson.manuscript.sanitized_at).toBeNull();
    expect(genJson.manuscript.body_html).not.toContain('<script>');
    expect(genJson.manuscript.body_html).not.toContain('onclick=');
    expect(genJson.unresolved_verify_count).toBeGreaterThan(0);

    // Request 2: verify-sanitize
    const verifyRes = await SELF.fetch(
      `https://worker.test/api/manuscripts/${manuscriptId}/verify-sanitize`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    expect(verifyRes.status).toBe(200);
    const verified = verifySanitizeResponseSchema.parse(await verifyRes.json());
    expect(verified.manuscript.sanitized_at).not.toBeNull();
    expect(verified.verified_claim_count).toBe(1);
    expect(verified.flagged_claim_count).toBeGreaterThanOrEqual(1);
    expect(verified.unresolved_verify_count).toBeGreaterThanOrEqual(1);

    // HTMLRewriter + sanitizeManuscriptHtml verification
    expect(verified.manuscript.body_html).not.toContain('<script>');
    expect(verified.manuscript.body_html).not.toContain('onclick=');
    expect(verified.manuscript.body_html).not.toContain('evil.example');
    expect(verified.manuscript.body_html).toContain(
      '<a href="https://developers.cloudflare.com/d1/platform/limits/">공식 문서</a>'
    );
    expect(verified.manuscript.body_html).toContain('악성 링크');
    expect(verified.manuscript.body_html).toContain('[VERIFY]');

    // Approve while unresolved [VERIFY] exists -> MUST fail 422 VERIFY_UNRESOLVED
    const blockedApprove = await SELF.fetch(
      `https://worker.test/api/manuscripts/${manuscriptId}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_hash: verified.manuscript.content_hash })
      }
    );
    expect(blockedApprove.status).toBe(422);
    expect(((await blockedApprove.json()) as { error: { code: string } }).error.code).toBe(
      'VERIFY_UNRESOLVED'
    );

    // Resolve every VERIFY_REQUIRED claim via resolve-verify
    let latestHash = verified.manuscript.content_hash;
    const unverifiedClaims = verified.manuscript.claims.filter(
      (c) => c.verification_status === 'VERIFY_REQUIRED'
    );
    for (const cItem of unverifiedClaims) {
      const resolveRes = await SELF.fetch(
        `https://worker.test/api/manuscripts/${manuscriptId}/resolve-verify`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            claim_id: cItem.claim_id,
            action: 'confirm_with_url',
            resolution_url: 'https://developers.cloudflare.com/d1/platform/pricing/'
          })
        }
      );
      expect(resolveRes.status).toBe(200);
      const resolvedJson = manuscriptResponseSchema.parse(await resolveRes.json());
      latestHash = resolvedJson.manuscript.content_hash;
    }

    // Approve with stale hash -> 409 HASH_MISMATCH
    const staleHashApprove = await SELF.fetch(
      `https://worker.test/api/manuscripts/${manuscriptId}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_hash: verified.manuscript.content_hash })
      }
    );
    expect(staleHashApprove.status).toBe(409);
    expect(((await staleHashApprove.json()) as { error: { code: string } }).error.code).toBe(
      'HASH_MISMATCH'
    );

    // Approve with latest hash -> 200 OK
    const approveRes = await SELF.fetch(
      `https://worker.test/api/manuscripts/${manuscriptId}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_hash: latestHash, ngram_max_similarity: 0.12 })
      }
    );
    expect(approveRes.status).toBe(200);
    const approvedJson = manuscriptResponseSchema.parse(await approveRes.json());
    expect(approvedJson.manuscript.approved_hash).toBe(latestHash);
    expect(approvedJson.manuscript.approved_at).not.toBeNull();

    // Detail endpoint returns comparison_context without calling Phase 4 download-urls
    const detailRes = await SELF.fetch(`https://worker.test/api/manuscripts/${manuscriptId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(detailRes.status).toBe(200);
    const detailJson = manuscriptDetailResponseSchema.parse(await detailRes.json());
    expect(detailJson.comparison_context.sources).toHaveLength(1);
    expect(detailJson.comparison_context.serp_snippets).toHaveLength(1);

    // PATCH edit must automatically clear existing approval and bump version + hash
    const patchRes = await SELF.fetch(`https://worker.test/api/manuscripts/${manuscriptId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_title: '수정된 제목으로 변경' })
    });
    expect(patchRes.status).toBe(200);
    const patchedJson = manuscriptResponseSchema.parse(await patchRes.json());
    expect(patchedJson.manuscript.approved_hash).toBeNull();
    expect(patchedJson.manuscript.approved_at).toBeNull();
    expect(patchedJson.manuscript.content_hash).not.toBe(latestHash);
  });

  it('blocks manuscript generation with 422 LLM_CONSENT_REQUIRED when CaptureAsset has no llm_consent_at', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const nowIso = new Date().toISOString();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      throw new Error(`LLM must not be called without consent: ${url}`);
    });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('cat-vlog-nc', 'owner-uid-1', '일상', 'none', NULL, '이웃공개', ?, ?, ?)`
      ).bind(
        JSON.stringify({
          category_id: 'cat-vlog-nc',
          display_name: '일상',
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
         VALUES ('cap-no-consent', 'owner-uid-1', 'cat-vlog-nc', 'vlog', NULL, ?, ?, ?)`
      ).bind(
        JSON.stringify({
          capture_id: 'cap-no-consent',
          category_id: 'cat-vlog-nc',
          content_type: 'vlog',
          photos: [],
          field_memo: '동의 없는 개인 메모',
          sponsorship: { is_sponsored: false },
          store_location_consent: false,
          llm_consent_at: null,
          created_at: nowIso,
          updated_at: nowIso
        }),
        nowIso,
        nowIso
      ),
      env.DB.prepare(
        `INSERT INTO topics (topic_id, owner_uid, run_id, track, category_id, content_type, status, ymyl_status, topic_json, created_at, updated_at)
         VALUES ('topic-no-consent', 'owner-uid-1', 'run-nc', 'personal_vlog', 'cat-vlog-nc', 'vlog', 'READY', 'SAFE', ?, ?, ?)`
      ).bind(
        JSON.stringify({
          topic_id: 'topic-no-consent',
          run_id: 'run-nc',
          track: 'personal_vlog',
          category_id: 'cat-vlog-nc',
          content_type: 'vlog',
          status: 'READY',
          keyword: '개인 일상',
          capture_ids: ['cap-no-consent'],
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

    const res = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-no-consent' })
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'LLM_CONSENT_REQUIRED'
    );
  });

  it('blocks approve with 422 VERIFY_REQUIRED when vlog/experience_review has 0 claims and verify-sanitize was skipped, and allows after verify-sanitize', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const nowIso = new Date().toISOString();

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
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify({ verdict: 'SAFE', reason: '비YMYL 일상 기록' }) }]
                  }
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title_candidates: ['주말 성수동 산책 일기'],
                        selected_title: '주말 성수동 산책 일기',
                        body_html:
                          '<script>alert("xss")</script><p>주말 오후 성수동 골목을 걸으며 따뜻한 드립 커피를 마셨습니다.</p>',
                        tags: ['성수동', '브이로그'],
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

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('cat-vlog-0c', 'owner-uid-1', '일상브이로그', 'none', NULL, '이웃공개', ?, ?, ?)`
      ).bind(
        JSON.stringify({
          category_id: 'cat-vlog-0c',
          display_name: '일상브이로그',
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
         VALUES ('cap-vlog-0c', 'owner-uid-1', 'cat-vlog-0c', 'vlog', ?, ?, ?, ?)`
      ).bind(
        nowIso,
        JSON.stringify({
          capture_id: 'cap-vlog-0c',
          category_id: 'cat-vlog-0c',
          content_type: 'vlog',
          photos: [],
          field_memo: '주말 오후 성수동 골목 산책과 드립 커피',
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
         VALUES ('topic-vlog-0c', 'owner-uid-1', 'run-v0c', 'personal_vlog', 'cat-vlog-0c', 'vlog', 'READY', 'SAFE', ?, ?, ?)`
      ).bind(
        JSON.stringify({
          topic_id: 'topic-vlog-0c',
          run_id: 'run-v0c',
          track: 'personal_vlog',
          category_id: 'cat-vlog-0c',
          content_type: 'vlog',
          status: 'READY',
          keyword: '성수동 산책',
          capture_ids: ['cap-vlog-0c'],
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

    const genRes = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-vlog-0c' })
    });
    expect(genRes.status).toBe(201);
    const generated = manuscriptResponseSchema.parse(await genRes.json());
    expect(generated.manuscript.claims).toHaveLength(0);
    expect(generated.manuscript.sanitized_at).toBeNull();
    // generate 직후 저장 본문에서도 script가 이미 제거되어 있어야 함
    expect(generated.manuscript.body_html).not.toContain('<script>');

    // verify-sanitize 없이 바로 approve 시도 -> 422 VERIFY_REQUIRED 차단
    const skippedApprove = await SELF.fetch(
      `https://worker.test/api/manuscripts/${generated.manuscript.manuscript_id}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_hash: generated.manuscript.content_hash })
      }
    );
    expect(skippedApprove.status).toBe(422);
    expect(((await skippedApprove.json()) as { error: { code: string } }).error.code).toBe(
      'VERIFY_REQUIRED'
    );

    // verify-sanitize 수행 후 sanitized_at 기록 -> approve 정상 통과
    const verifyRes = await SELF.fetch(
      `https://worker.test/api/manuscripts/${generated.manuscript.manuscript_id}/verify-sanitize`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    expect(verifyRes.status).toBe(200);
    const verified = verifySanitizeResponseSchema.parse(await verifyRes.json());
    expect(verified.manuscript.sanitized_at).not.toBeNull();

    const approveRes = await SELF.fetch(
      `https://worker.test/api/manuscripts/${generated.manuscript.manuscript_id}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_hash: verified.manuscript.content_hash })
      }
    );
    expect(approveRes.status).toBe(200);
  });

  it('auto-flags ungrounded numeric tokens in explainer body even when LLM omits claims ([]) and blocks approve', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    await seedExplainerTopicWithSnapshot();

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
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify({ verdict: 'SAFE', reason: '비YMYL' }) }]
                  }
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        // LLM omits claims completely ([]) while writing ungrounded numbers (3개, 777GB) in body
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title_candidates: ['D1 숨은 수치 테스트'],
                        selected_title: 'D1 숨은 수치 테스트',
                        body_html:
                          '<p>최대 3개 리전에서 777GB 용량을 무료 제공합니다.</p><p>[📷 이미지 1 삽입 위치: 참고 도식]</p>',
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
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const genRes = await SELF.fetch('https://worker.test/api/manuscripts/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: 'topic-exp-1' })
    });
    expect(genRes.status).toBe(201);
    const gen = manuscriptResponseSchema.parse(await genRes.json());

    const verifyRes = await SELF.fetch(
      `https://worker.test/api/manuscripts/${gen.manuscript.manuscript_id}/verify-sanitize`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    expect(verifyRes.status).toBe(200);
    const verified = verifySanitizeResponseSchema.parse(await verifyRes.json());
    expect(verified.unresolved_verify_count).toBeGreaterThanOrEqual(1);
    expect(verified.manuscript.body_html).toContain('[VERIFY]');
    // 사진 마커의 "이미지 1"은 제외하고 본문 수치(3개, 777gb)만 탐지해야 함
    const autoClaim = verified.manuscript.claims.find((c) => c.claim_id.startsWith('auto-num-'));
    expect(autoClaim?.claim).toContain('3개');
    expect(autoClaim?.claim).toContain('777gb');
    expect(autoClaim?.claim).not.toContain('이미지 1');

    const blockedApprove = await SELF.fetch(
      `https://worker.test/api/manuscripts/${gen.manuscript.manuscript_id}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_hash: verified.manuscript.content_hash })
      }
    );
    expect(blockedApprove.status).toBe(422);
    expect(((await blockedApprove.json()) as { error: { code: string } }).error.code).toBe(
      'VERIFY_UNRESOLVED'
    );
  });

  it('recalculates ai_disclosure and content_hash when PATCH /api/manuscripts/:id toggles is_ai_generated images', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const nowIso = new Date().toISOString();

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

    await seedExplainerTopicWithSnapshot();
    const initialHash = 'c'.repeat(64);
    const initialBundle = {
      manuscript_id: 'ms-ai-patch-1',
      topic_id: 'topic-exp-1',
      version: 1,
      content_hash: initialHash,
      title_candidates: ['AI 도식 테스트'],
      selected_title: 'AI 도식 테스트',
      body_html: '<p>본문입니다.</p>',
      naver_board_name: 'IT해설',
      sponsorship: { is_sponsored: false },
      ftc_disclosure: null,
      ai_disclosure: null,
      images: [],
      tags: ['테크'],
      visibility: '전체공개',
      claims: [],
      ngram_max_similarity: null,
      sanitized_at: nowIso,
      approved_hash: null,
      approved_at: null
    };

    await env.DB.prepare(
      `INSERT INTO manuscripts (manuscript_id, owner_uid, topic_id, category_id, content_type, run_id, version, content_hash, approved_hash, approved_at, unresolved_verify_count, bundle_json, created_at, updated_at)
       VALUES ('ms-ai-patch-1', 'owner-uid-1', 'topic-exp-1', 'cat-exp', 'explainer', 'run-ai-patch', 1, ?, NULL, NULL, 0, ?, ?, ?)`
    )
      .bind(initialHash, JSON.stringify(initialBundle), nowIso, nowIso)
      .run();

    // 1) Add AI-generated diagram image -> ai_disclosure must be recalculated to non-null string
    const patchAddAi = await SELF.fetch('https://worker.test/api/manuscripts/ms-ai-patch-1', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images: [
          {
            seq: 1,
            r2_key: 'users/owner-uid-1/ai-images/ms-ai-patch-1/1.png',
            caption: '개념 도식',
            is_ai_generated: true
          }
        ]
      })
    });
    expect(patchAddAi.status).toBe(200);
    const withAi = manuscriptResponseSchema.parse(await patchAddAi.json());
    expect(withAi.manuscript.ai_disclosure).toContain('AI로 생성');
    expect(withAi.manuscript.content_hash).not.toBe(initialHash);

    // 2) Replace with real photo (is_ai_generated: false) -> ai_disclosure must clear back to null
    const patchRemoveAi = await SELF.fetch('https://worker.test/api/manuscripts/ms-ai-patch-1', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images: [
          {
            seq: 1,
            r2_key: 'users/owner-uid-1/captures/cap-1/1.webp',
            caption: '실물 사진',
            is_ai_generated: false
          }
        ]
      })
    });
    expect(patchRemoveAi.status).toBe(200);
    const withoutAi = manuscriptResponseSchema.parse(await patchRemoveAi.json());
    expect(withoutAi.manuscript.ai_disclosure).toBeNull();
    expect(withoutAi.manuscript.content_hash).not.toBe(withAi.manuscript.content_hash);
  });
});
