import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capturePresignResponseSchema,
  captureResponseSchema,
  capturesListResponseSchema,
  MAX_CAPTURE_FILE_BYTES
} from '@content-desk/shared';
import type { UserScope } from '../src/env.js';
import { clearFirebaseCertCacheForTests } from '../src/middleware/firebase-auth.js';
import {
  presignR2GetUrl,
  R2_GET_EXPIRES_SECONDS,
  R2_PUT_EXPIRES_SECONDS,
  resolveR2SignerConfig
} from '../src/services/r2-signer.js';
import { generateTestCertKeyPair, signFirebaseToken, type TestCertKeyPair } from './helpers/jwt.js';

let keyPair: TestCertKeyPair;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keyPair = await generateTestCertKeyPair('kid-captures-test');
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
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ verdict: 'SAFE', reason: '비YMYL 주제입니다.' }) }]
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected external fetch in captures.test: ${url}`);
  });
});

async function seedCategory(token: string, overrides?: Partial<Record<string, unknown>>): Promise<string> {
  const res = await SELF.fetch('https://worker.test/api/categories', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      display_name: '맛집 탐방',
      naver_board_name: '맛집',
      discovery_mode: 'experience_first',
      datalab_anchor_keyword: '성수동 맛집',
      seed_keywords: ['성수 카페'],
      primary_source_domains: [],
      default_media_policy: {
        allowed_content_types: ['experience_review'],
        min_real_photos: 0,
        require_field_memo: false
      },
      default_visibility: '전체공개',
      ...overrides
    })
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { category: { category_id: string } };
  return body.category.category_id;
}

describe('캡처 API · R2 SigV4 서명 URL · Miniflare R2 HEAD 검증 · LLM 전송 동의 (/api/captures)', () => {
  it('signs PUT URL with content-length;content-type;host, verifies R2 HEAD on POST /api/captures, and records consent', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const categoryId = await seedCategory(token);
    const dummyBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03]);

    const presignRes = await SELF.fetch('https://worker.test/api/captures/presign', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capture_id: 'cap-sigv4-01',
        category_id: categoryId,
        files: [
          { seq: 1, content_type: 'image/webp', byte_size: dummyBytes.byteLength },
          { seq: 2, content_type: 'image/jpeg', byte_size: 240_000 }
        ]
      })
    });
    expect(presignRes.status).toBe(200);
    const presign = capturePresignResponseSchema.parse(await presignRes.json());
    expect(presign.expires_in_seconds).toBe(R2_PUT_EXPIRES_SECONDS);
    expect(presign.uploads).toHaveLength(2);

    const first = presign.uploads[0]!;
    const second = presign.uploads[1]!;
    expect(first.r2_key).toBe('users/owner-uid-1/captures/cap-sigv4-01/1.webp');
    expect(second.r2_key).toBe('users/owner-uid-1/captures/cap-sigv4-01/2.jpg');

    // Verify SigV4 query parameters including content-length in X-Amz-SignedHeaders
    const parsedUrl = new URL(first.upload_url);
    expect(parsedUrl.origin).toBe('https://test-r2-account-id.r2.cloudflarestorage.com');
    expect(parsedUrl.pathname).toBe(
      '/content-desk-bucket/users/owner-uid-1/captures/cap-sigv4-01/1.webp'
    );
    expect(parsedUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsedUrl.searchParams.get('X-Amz-Credential')).toMatch(
      /^test-r2-access-key-id\/\d{8}\/auto\/s3\/aws4_request$/
    );
    expect(parsedUrl.searchParams.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(parsedUrl.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsedUrl.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host'
    );
    expect(parsedUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    // Simulate direct R2 PUT into Miniflare MEDIA_BUCKET
    await env.MEDIA_BUCKET.put(first.r2_key, dummyBytes, {
      httpMetadata: { contentType: first.content_type }
    });
    const stored = await env.MEDIA_BUCKET.get(first.r2_key);
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe('image/webp');
    const storedBuf = new Uint8Array(await stored!.arrayBuffer());
    expect(Array.from(storedBuf)).toEqual(Array.from(dummyBytes));

    // Verify GET presign helper (10 min expiry + owner prefix guard)
    const signerConfig = resolveR2SignerConfig(env);
    const scope = { uid: 'owner-uid-1' } as UserScope;
    const getSigned = await presignR2GetUrl(scope, signerConfig, { objectKey: first.r2_key });
    const getUrl = new URL(getSigned.url);
    expect(getUrl.searchParams.get('X-Amz-Expires')).toBe(String(R2_GET_EXPIRES_SECONDS));
    expect(getUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    await expect(
      presignR2GetUrl(scope, signerConfig, { objectKey: 'users/other-user/captures/cap-1/1.webp' })
    ).rejects.toThrow(/owner|소유/i);

    // Save CaptureAsset with KST offset taken_at + matching mime_type & byte_size
    const createRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capture_id: 'cap-sigv4-01',
        category_id: categoryId,
        content_type: 'experience_review',
        photos: [
          {
            seq: 1,
            r2_key: first.r2_key,
            mime_type: 'image/webp',
            byte_size: dummyBytes.byteLength,
            taken_at: '2026-11-26T14:30:00+09:00',
            width: 2560,
            height: 1707,
            caption: '시그니처 라떼'
          }
        ],
        field_memo: '산미가 적당하고 크레마가 진했습니다.',
        sponsorship: { is_sponsored: false },
        store_location_consent: false
      })
    });
    expect(createRes.status).toBe(201);
    const created = captureResponseSchema.parse(await createRes.json());
    expect(created.capture.capture_id).toBe('cap-sigv4-01');
    expect(created.capture.llm_consent_at).toBeNull();

    // List and detail
    const listRes = await SELF.fetch(`https://worker.test/api/captures?category_id=${categoryId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(listRes.status).toBe(200);
    const listed = capturesListResponseSchema.parse(await listRes.json());
    expect(listed.captures).toHaveLength(1);

    const detailRes = await SELF.fetch('https://worker.test/api/captures/cap-sigv4-01', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(detailRes.status).toBe(200);
    expect(captureResponseSchema.parse(await detailRes.json()).capture.photos).toHaveLength(1);

    // Record free LLM consent
    const consentRes = await SELF.fetch('https://worker.test/api/captures/cap-sigv4-01/consent', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledged_free_tier_training: true })
    });
    expect(consentRes.status).toBe(200);
    const consented = captureResponseSchema.parse(await consentRes.json());
    expect(consented.capture.llm_consent_at).not.toBeNull();

    // Verify POST /api/media/download-urls issues a 10-min GET signed URL for the uploaded capture
    const dlRes = await SELF.fetch('https://worker.test/api/media/download-urls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capture_id: 'cap-sigv4-01' })
    });
    expect(dlRes.status).toBe(200);
    const dlJson = (await dlRes.json()) as {
      expires_in_seconds: number;
      items: Array<{ r2_key: string; download_url: string }>;
    };
    expect(dlJson.expires_in_seconds).toBe(600);
    expect(dlJson.items).toHaveLength(1);
    expect(dlJson.items[0]!.r2_key).toBe('users/owner-uid-1/captures/cap-sigv4-01/1.webp');
    expect(dlJson.items[0]!.download_url).toContain('X-Amz-Expires=600');
  });

  it('rejects missing R2 object, oversized/mismatched R2 objects (and deletes them), and mismatched rebuilt r2_key with 400', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const categoryId = await seedCategory(token);

    // 1) Missing R2 object -> 400 VALIDATION_ERROR
    const missingRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capture_id: 'cap-missing-1',
        category_id: categoryId,
        content_type: 'experience_review',
        photos: [
          {
            seq: 1,
            r2_key: 'users/owner-uid-1/captures/cap-missing-1/1.webp',
            mime_type: 'image/webp',
            byte_size: 100,
            taken_at: null,
            width: 800,
            height: 600,
            caption: '미존재 객체'
          }
        ],
        field_memo: '메모'
      })
    });
    expect(missingRes.status).toBe(400);
    expect(((await missingRes.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR'
    );

    // 2) Oversized (> 5MB) object in R2 -> 400 VALIDATION_ERROR AND object deleted from R2
    const oversizedKey = 'users/owner-uid-1/captures/cap-oversize-1/1.webp';
    await env.MEDIA_BUCKET.put(oversizedKey, new Uint8Array(MAX_CAPTURE_FILE_BYTES + 1), {
      httpMetadata: { contentType: 'image/webp' }
    });
    expect(await env.MEDIA_BUCKET.head(oversizedKey)).not.toBeNull();

    const oversizedRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capture_id: 'cap-oversize-1',
        category_id: categoryId,
        content_type: 'experience_review',
        photos: [
          {
            seq: 1,
            r2_key: oversizedKey,
            mime_type: 'image/webp',
            byte_size: MAX_CAPTURE_FILE_BYTES,
            taken_at: null,
            width: 2560,
            height: 1707,
            caption: '5MB 초과 객체'
          }
        ],
        field_memo: '메모'
      })
    });
    expect(oversizedRes.status).toBe(400);
    expect(((await oversizedRes.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR'
    );
    expect(await env.MEDIA_BUCKET.head(oversizedKey)).toBeNull();

    // 3) MIME mismatch (image/png stored in R2) -> 400 VALIDATION_ERROR AND object deleted from R2
    const badMimeKey = 'users/owner-uid-1/captures/cap-badmime-1/1.webp';
    await env.MEDIA_BUCKET.put(badMimeKey, new Uint8Array([1, 2, 3, 4]), {
      httpMetadata: { contentType: 'image/png' }
    });
    expect(await env.MEDIA_BUCKET.head(badMimeKey)).not.toBeNull();

    const badMimeRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capture_id: 'cap-badmime-1',
        category_id: categoryId,
        content_type: 'experience_review',
        photos: [
          {
            seq: 1,
            r2_key: badMimeKey,
            mime_type: 'image/webp',
            byte_size: 4,
            taken_at: null,
            width: 800,
            height: 600,
            caption: 'MIME 불일치'
          }
        ],
        field_memo: '메모'
      })
    });
    expect(badMimeRes.status).toBe(400);
    expect(await env.MEDIA_BUCKET.head(badMimeKey)).toBeNull();

    // 4) byte_size mismatch -> 400 VALIDATION_ERROR AND object deleted from R2
    const badSizeKey = 'users/owner-uid-1/captures/cap-badsize-1/1.jpg';
    await env.MEDIA_BUCKET.put(badSizeKey, new Uint8Array([1, 2, 3, 4, 5, 6]), {
      httpMetadata: { contentType: 'image/jpeg' }
    });

    const badSizeRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capture_id: 'cap-badsize-1',
        category_id: categoryId,
        content_type: 'experience_review',
        photos: [
          {
            seq: 1,
            r2_key: badSizeKey,
            mime_type: 'image/jpeg',
            byte_size: 999,
            taken_at: null,
            width: 800,
            height: 600,
            caption: '크기 불일치'
          }
        ],
        field_memo: '메모'
      })
    });
    expect(badSizeRes.status).toBe(400);
    expect(await env.MEDIA_BUCKET.head(badSizeKey)).toBeNull();

    // 5) Server-rebuilt key mismatch (wrong extension / wrong seq / arbitrary subpath under caller prefix) -> 400
    for (const tamperedKey of [
      'users/owner-uid-1/captures/cap-keycheck-1/1.jpg', // mime_type is image/webp -> expected 1.webp
      'users/owner-uid-1/captures/cap-keycheck-1/2.webp', // seq is 1 -> expected 1.webp
      'users/owner-uid-1/captures/cap-keycheck-1/nested/1.webp'
    ]) {
      const tamperedRes = await SELF.fetch('https://worker.test/api/captures', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capture_id: 'cap-keycheck-1',
          category_id: categoryId,
          content_type: 'experience_review',
          photos: [
            {
              seq: 1,
              r2_key: tamperedKey,
              mime_type: 'image/webp',
              byte_size: 4,
              taken_at: null,
              width: 800,
              height: 600,
              caption: '키 불일치'
            }
          ],
          field_memo: '메모'
        })
      });
      expect(tamperedRes.status).toBe(400);
      expect(((await tamperedRes.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_ERROR'
      );
    }
  });

  it('allows memo-only captures (0 photos) and rejects empty input, gps payloads, and foreign r2_key', async () => {
    const token = await signFirebaseToken({ keyPair, sub: 'owner-uid-1' });
    const vlogCategoryId = await seedCategory(token, {
      display_name: '일상/브이로그',
      naver_board_name: '일상',
      discovery_mode: 'none',
      datalab_anchor_keyword: null,
      seed_keywords: [],
      default_media_policy: {
        allowed_content_types: ['vlog'],
        min_real_photos: 0,
        require_field_memo: true
      }
    });

    // Memo-only (0 photos) -> 201 Created
    const memoOnlyRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: vlogCategoryId,
        content_type: 'vlog',
        photos: [],
        field_memo: '비 오는 날 집에서 커피를 내리며 책을 읽었다.',
        sponsorship: { is_sponsored: false }
      })
    });
    expect(memoOnlyRes.status).toBe(201);
    const memoCapture = captureResponseSchema.parse(await memoOnlyRes.json());
    expect(memoCapture.capture.photos).toHaveLength(0);

    // Empty photos + blank memo -> 400
    const emptyRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: vlogCategoryId,
        content_type: 'vlog',
        photos: [],
        field_memo: '   ',
        sponsorship: { is_sponsored: false }
      })
    });
    expect(emptyRes.status).toBe(400);

    // GPS payload rejected -> 400
    const gpsRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: vlogCategoryId,
        content_type: 'vlog',
        photos: [],
        field_memo: '메모',
        gps: { lat: 37.5665, lng: 126.978 }
      })
    });
    expect(gpsRes.status).toBe(400);

    // Foreign owner r2_key rejected -> 400
    const foreignKeyRes = await SELF.fetch('https://worker.test/api/captures', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capture_id: 'cap-spoof-1',
        category_id: vlogCategoryId,
        content_type: 'vlog',
        photos: [
          {
            seq: 1,
            r2_key: 'users/other-user-uid/captures/cap-spoof-1/1.webp',
            mime_type: 'image/webp',
            byte_size: 100,
            taken_at: null,
            width: 800,
            height: 600,
            caption: '스푸핑'
          }
        ],
        field_memo: '메모'
      })
    });
    expect(foreignKeyRes.status).toBe(400);
    expect(((await foreignKeyRes.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR'
    );
  });
});
