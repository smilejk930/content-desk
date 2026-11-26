import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  categoriesListResponseSchema,
  categoryResponseSchema,
  getProviderWindowDate
} from '@content-desk/shared';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

function geminiVerdictResponse(verdict: 'SAFE' | 'BORDERLINE' | 'BLOCKED', reason: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify({ verdict, reason }) }]
          }
        }
      ]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-categories-test');
});

beforeEach(async () => {
  clearFirebaseCertCacheForTests();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM captures'),
    env.DB.prepare('DELETE FROM categories'),
    env.DB.prepare('DELETE FROM usage_daily'),
    env.DB.prepare('DELETE FROM quota_ledger'),
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
      return geminiVerdictResponse('SAFE', '일반 비YMYL 주제입니다.');
    }
    throw new Error(`Unexpected external fetch in categories.test: ${url}`);
  });
});

describe('카테고리 API CRUD · 조합표 · Phase 3 YMYL 2중 판정 (/api/categories)', () => {
  it('supports full CRUD lifecycle and enforces unique display_name per owner', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });

    const createRes = await SELF.fetch('https://worker.test/api/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: '테크/IT',
        naver_board_name: 'IT리뷰',
        discovery_mode: 'trend_first',
        datalab_anchor_keyword: '클라우드',
        seed_keywords: ['Workers', 'D1'],
        primary_source_domains: ['developers.cloudflare.com'],
        default_media_policy: {
          allowed_content_types: ['explainer', 'experience_review'],
          min_real_photos: 0,
          require_field_memo: false
        },
        default_visibility: '전체공개'
      })
    });
    expect(createRes.status).toBe(201);
    const createdJson = categoryResponseSchema.parse(await createRes.json());
    const catId = createdJson.category.category_id;
    expect(createdJson.category.display_name).toBe('테크/IT');

    // Verify Stage 2 Gemini call recorded in quota_ledger + usage_daily
    const pacificDate = getProviderWindowDate('gemini_text');
    const usageRow = await env.DB.prepare(
      `SELECT calls FROM usage_daily WHERE owner_uid = ? AND provider = 'gemini_text' AND window_date = ?`
    )
      .bind('owner-uid-1', pacificDate)
      .first<{ calls: number }>();
    expect(usageRow?.calls).toBe(1);

    // Duplicate display_name -> 409 CONFLICT
    const dupRes = await SELF.fetch('https://worker.test/api/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: '테크/IT',
        naver_board_name: '중복게시판',
        discovery_mode: 'experience_first',
        datalab_anchor_keyword: 'IT',
        seed_keywords: [],
        primary_source_domains: [],
        default_media_policy: {
          allowed_content_types: ['experience_review'],
          min_real_photos: 1,
          require_field_memo: true
        },
        default_visibility: '전체공개'
      })
    });
    expect(dupRes.status).toBe(409);
    expect(((await dupRes.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');

    // List
    const listRes = await SELF.fetch('https://worker.test/api/categories', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(listRes.status).toBe(200);
    const listJson = categoriesListResponseSchema.parse(await listRes.json());
    expect(listJson.categories).toHaveLength(1);
    expect(listJson.categories[0]!.category_id).toBe(catId);

    // Patch
    const patchRes = await SELF.fetch(`https://worker.test/api/categories/${catId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        naver_board_name: '개발자노트',
        default_visibility: '이웃공개'
      })
    });
    expect(patchRes.status).toBe(200);
    const patched = categoryResponseSchema.parse(await patchRes.json());
    expect(patched.category.naver_board_name).toBe('개발자노트');
    expect(patched.category.default_visibility).toBe('이웃공개');

    // Delete
    const delRes = await SELF.fetch(`https://worker.test/api/categories/${catId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true, category_id: catId });

    const delAgain = await SELF.fetch(`https://worker.test/api/categories/${catId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(delAgain.status).toBe(404);
  });

  it('rejects invalid discovery_mode + allowed_content_types combinations on POST and PATCH', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });

    const badPost = await SELF.fetch('https://worker.test/api/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: '맛집',
        naver_board_name: '맛집기록',
        discovery_mode: 'experience_first',
        datalab_anchor_keyword: '맛집',
        seed_keywords: [],
        primary_source_domains: ['example.com'],
        default_media_policy: {
          allowed_content_types: ['explainer'],
          min_real_photos: 0,
          require_field_memo: false
        },
        default_visibility: '전체공개'
      })
    });
    expect(badPost.status).toBe(400);

    const validRes = await SELF.fetch('https://worker.test/api/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: '일상/브이로그',
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
        default_visibility: '이웃공개'
      })
    });
    expect(validRes.status).toBe(201);
    const { category } = categoryResponseSchema.parse(await validRes.json());

    const badPatch = await SELF.fetch(`https://worker.test/api/categories/${category.category_id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ discovery_mode: 'experience_first' })
    });
    expect(badPatch.status).toBe(400);
  });

  it('blocks Stage 1 YMYL keywords immediately with 422 YMYL_BLOCKED without calling Gemini or touching quota', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    let geminiCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiCalls += 1;
        return geminiVerdictResponse('SAFE', 'ok');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const ymylCases = [
      { display_name: '주식 투자 노트', seed_keywords: ['미국주식'] },
      { display_name: '일상 기록', seed_keywords: ['처방약 복용법'] },
      { display_name: '건강', seed_keywords: ['루틴'] },
      { display_name: '법률 상식', seed_keywords: ['민사소송'] }
    ];

    for (const tc of ymylCases) {
      const res = await SELF.fetch('https://worker.test/api/categories', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: tc.display_name,
          naver_board_name: '게시판',
          discovery_mode: 'experience_first',
          datalab_anchor_keyword: '기준키워드',
          seed_keywords: tc.seed_keywords,
          primary_source_domains: [],
          default_media_policy: {
            allowed_content_types: ['experience_review'],
            min_real_photos: 0,
            require_field_memo: false
          },
          default_visibility: '전체공개'
        })
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; details?: { stage?: string } } };
      expect(body.error.code).toBe('YMYL_BLOCKED');
      expect(body.error.details?.stage).toBe('primary');
    }

    expect(geminiCalls).toBe(0);
    const usageCount = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM usage_daily').first<{
      cnt: number;
    }>();
    expect(usageCount?.cnt).toBe(0);
  });

  it('enforces Stage 2 Gemini verdicts: 422 BLOCKED, 409 BORDERLINE + confirm_borderline retry, missing key block, and quota exhaustion block', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const workerModule = (await import('../src/index.js')).default;

    const makePayload = (name: string, extra?: Record<string, unknown>) =>
      JSON.stringify({
        display_name: name,
        naver_board_name: '게시판',
        discovery_mode: 'experience_first',
        datalab_anchor_keyword: '기준키워드',
        seed_keywords: ['생활팁'],
        primary_source_domains: [],
        default_media_policy: {
          allowed_content_types: ['experience_review'],
          min_real_photos: 0,
          require_field_memo: false
        },
        default_visibility: '전체공개',
        ...extra
      });

    // 1) Missing GEMINI_API_KEY -> 503 YMYL_SECONDARY_UNAVAILABLE (blocks registration)
    const missingKeyRes = await workerModule.fetch(
      new Request('https://worker.test/api/categories', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: makePayload('성수동 카페')
      }),
      { ...env, GEMINI_API_KEY: '' },
      {} as ExecutionContext
    );
    expect(missingKeyRes.status).toBe(503);
    expect(((await missingKeyRes.json()) as { error: { code: string } }).error.code).toBe(
      'YMYL_SECONDARY_UNAVAILABLE'
    );

    // 2) Stage 2 BLOCKED -> 422 YMYL_BLOCKED
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return geminiVerdictResponse('BLOCKED', '민간 의학 요법으로 고위험 YMYL 주제입니다.');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const stage2Blocked = await SELF.fetch('https://worker.test/api/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: makePayload('특수 요법 체험')
    });
    expect(stage2Blocked.status).toBe(422);
    const blockedJson = (await stage2Blocked.json()) as {
      error: { code: string; details?: { stage?: string } };
    };
    expect(blockedJson.error.code).toBe('YMYL_BLOCKED');
    expect(blockedJson.error.details?.stage).toBe('secondary');

    // 3) Stage 2 BORDERLINE -> 409 YMYL_BORDERLINE_CONFIRM_REQUIRED, then confirm_borderline=true -> 201
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return geminiVerdictResponse('BORDERLINE', '건강한 개발 습관은 맥락 확인이 필요한 경계 주제입니다.');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const borderlineFirst = await SELF.fetch('https://worker.test/api/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: makePayload('건강한 개발 습관')
    });
    expect(borderlineFirst.status).toBe(409);
    expect(((await borderlineFirst.json()) as { error: { code: string } }).error.code).toBe(
      'YMYL_BORDERLINE_CONFIRM_REQUIRED'
    );

    const borderlineConfirmed = await SELF.fetch('https://worker.test/api/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: makePayload('건강한 개발 습관', { confirm_borderline: true })
    });
    expect(borderlineConfirmed.status).toBe(201);
    const { category } = categoryResponseSchema.parse(await borderlineConfirmed.json());

    // 4) Exhaust gemini_text daily quota -> 429 QUOTA_EXCEEDED on PATCH & POST, usage_daily unchanged
    const pacificDate = getProviderWindowDate('gemini_text');
    const beforeUsage = await env.DB.prepare(
      `SELECT calls FROM usage_daily WHERE owner_uid = ? AND provider = 'gemini_text' AND window_date = ?`
    )
      .bind('owner-uid-1', pacificDate)
      .first<{ calls: number }>();

    await env.DB.prepare(
      `UPDATE quota_ledger SET used = daily_cap, reserved = 0 WHERE provider = 'gemini_text' AND window_date = ?`
    )
      .bind(pacificDate)
      .run();

    const quotaBlockedPatch = await SELF.fetch(
      `https://worker.test/api/categories/${category.category_id}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: '새 카테고리 이름' })
      }
    );
    expect(quotaBlockedPatch.status).toBe(429);
    expect(((await quotaBlockedPatch.json()) as { error: { code: string } }).error.code).toBe(
      'QUOTA_EXCEEDED'
    );

    const afterUsage = await env.DB.prepare(
      `SELECT calls FROM usage_daily WHERE owner_uid = ? AND provider = 'gemini_text' AND window_date = ?`
    )
      .bind('owner-uid-1', pacificDate)
      .first<{ calls: number }>();
    expect(afterUsage?.calls).toBe(beforeUsage?.calls);
  });
});
