import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { categoriesListResponseSchema, categoryResponseSchema } from '@content-desk/shared';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import { evaluateYmyl } from '../src/services/ymyl.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-categories-test');
});

beforeEach(async () => {
  clearFirebaseCertCacheForTests();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM captures'),
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
    throw new Error(`Unexpected external fetch in categories.test: ${url}`);
  });
});

describe('카테고리 API CRUD · 조합표 · Phase 2 YMYL 1차 차단 (/api/categories)', () => {
  it('supports full CRUD lifecycle and enforces unique display_name per owner', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });

    // Create
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

    // Deleting again -> 404
    const delAgain = await SELF.fetch(`https://worker.test/api/categories/${catId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(delAgain.status).toBe(404);
  });

  it('rejects invalid discovery_mode + allowed_content_types combinations on POST and PATCH', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });

    // Invalid POST: experience_first with explainer
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
    expect(((await badPost.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    // Create valid vlog category
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

    // Invalid PATCH: switching mode to experience_first without updating content_type/anchor
    const badPatch = await SELF.fetch(`https://worker.test/api/categories/${category.category_id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discovery_mode: 'experience_first'
      })
    });
    expect(badPatch.status).toBe(400);
    expect(((await badPatch.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('always blocks Stage 1 YMYL keywords with 422 YMYL_BLOCKED even without GEMINI_API_KEY', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });

    const ymylCases = [
      { display_name: '주식 투자 노트', seed_keywords: ['미국주식'] },
      { display_name: '일상 기록', seed_keywords: ['처방약 복용법'] },
      { display_name: '부동산 청약 가이드', seed_keywords: ['분양'] },
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
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('YMYL_BLOCKED');
    }
  });

  it('does not call external Gemini fetch in Phase 2 even when GEMINI_API_KEY is set and enforces Stage 1 keyword blocking only', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const workerModule = (await import('../src/index.js')).default;

    const makeBody = (name: string, seedKeywords: string[] = ['생활노하우']) =>
      JSON.stringify({
        display_name: name,
        naver_board_name: '자유게시판',
        discovery_mode: 'experience_first',
        datalab_anchor_keyword: '생활팁',
        seed_keywords: seedKeywords,
        primary_source_domains: [],
        default_media_policy: {
          allowed_content_types: ['experience_review'],
          min_real_photos: 0,
          require_field_memo: false
        },
        default_visibility: '전체공개'
      });

    let geminiCallCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('securetoken@system.gserviceaccount.com')) {
        return new Response(JSON.stringify({ [keyPair.kid]: keyPair.certPem }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
        });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiCallCount += 1;
        throw new Error(`Gemini external fetch must not be called in Phase 2: ${url}`);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // 1) POST non-YMYL with GEMINI_API_KEY set -> 201 Created, Gemini fetch not called
    const createRes = await workerModule.fetch(
      new Request('https://worker.test/api/categories', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: makeBody('건강한 개발 습관')
      }),
      { ...env, GEMINI_API_KEY: 'dummy-gemini-test-key' },
      {} as ExecutionContext
    );
    expect(createRes.status).toBe(201);
    const { category } = categoryResponseSchema.parse(await createRes.json());
    expect(geminiCallCount).toBe(0);

    // 2) PATCH non-YMYL with GEMINI_API_KEY set -> 200 OK, Gemini fetch not called
    const patchSafeRes = await workerModule.fetch(
      new Request(`https://worker.test/api/categories/${category.category_id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: '성수동 카페 기록' })
      }),
      { ...env, GEMINI_API_KEY: 'dummy-gemini-test-key' },
      {} as ExecutionContext
    );
    expect(patchSafeRes.status).toBe(200);
    expect(geminiCallCount).toBe(0);

    // 3) POST Stage 1 YMYL keyword with GEMINI_API_KEY set -> 422 YMYL_BLOCKED (primary), Gemini fetch not called
    const blockedPostRes = await workerModule.fetch(
      new Request('https://worker.test/api/categories', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: makeBody('주식 투자 노트', ['미국주식'])
      }),
      { ...env, GEMINI_API_KEY: 'dummy-gemini-test-key' },
      {} as ExecutionContext
    );
    expect(blockedPostRes.status).toBe(422);
    const blockedPostJson = (await blockedPostRes.json()) as {
      error: { code: string; details?: { stage?: string } };
    };
    expect(blockedPostJson.error.code).toBe('YMYL_BLOCKED');
    expect(blockedPostJson.error.details?.stage).toBe('primary');
    expect(geminiCallCount).toBe(0);

    // 4) PATCH Stage 1 YMYL keyword with GEMINI_API_KEY set -> 422 YMYL_BLOCKED (primary), Gemini fetch not called
    const blockedPatchRes = await workerModule.fetch(
      new Request(`https://worker.test/api/categories/${category.category_id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: '법률 상담 가이드' })
      }),
      { ...env, GEMINI_API_KEY: 'dummy-gemini-test-key' },
      {} as ExecutionContext
    );
    expect(blockedPatchRes.status).toBe(422);
    expect(((await blockedPatchRes.json()) as { error: { code: string } }).error.code).toBe('YMYL_BLOCKED');
    expect(geminiCallCount).toBe(0);

    // 5) Direct evaluateYmyl service guard: even when geminiApiKey is passed directly, Phase 2 stays primary_only
    const directResult = await evaluateYmyl(['특수 요법 체험기'], {
      geminiApiKey: 'dummy-gemini-test-key'
    });
    expect(directResult.status).toBe('SAFE');
    expect(directResult.stage).toBe('primary_only');
    expect(directResult.secondaryChecked).toBe(false);
    expect(geminiCallCount).toBe(0);
  });
});
