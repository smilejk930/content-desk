import { describe, expect, it } from 'vitest';
import {
  adminUsersListResponseSchema,
  API_ERROR_CODES,
  captureAssetSchema,
  capturePresignRequestSchema,
  categoryProfileSchema,
  createAdminUserRequestSchema,
  createCaptureRequestSchema,
  createCategoryRequestSchema,
  exportResponseSchema,
  llmConsentRequestSchema,
  meResponseSchema,
  topicDiscoverySchema,
  updateAdminUserRequestSchema,
  updateCategoryRequestSchema
} from '../src/index.js';

describe('Zod 4 schemas', () => {
  it('enforces datalab_anchor_keyword for trend_first and primary_source_domains for explainer', () => {
    const invalid = categoryProfileSchema.safeParse({
      category_id: 'tech',
      display_name: '테크/IT',
      naver_board_name: 'IT리뷰',
      discovery_mode: 'trend_first',
      datalab_anchor_keyword: null,
      seed_keywords: ['클라우드'],
      primary_source_domains: [],
      default_media_policy: {
        allowed_content_types: ['explainer'],
        min_real_photos: 0,
        require_field_memo: false
      },
      default_visibility: '전체공개',
      created_at: '2026-11-20T00:00:00.000Z',
      updated_at: '2026-11-20T00:00:00.000Z'
    });
    expect(invalid.success).toBe(false);
  });

  it('rejects unknown fields via strictObject and disallows non-webp/jpeg upload MIME', () => {
    const res = capturePresignRequestSchema.safeParse({
      capture_id: 'cap-1',
      category_id: 'cat-1',
      files: [{ seq: 1, content_type: 'image/png', byte_size: 1024 }],
      extra_field: true
    });
    expect(res.success).toBe(false);
  });

  it('enforces discovery_mode to allowed_content_types matrix on create/update category schemas', () => {
    // trend_first allows explainer + experience_review, rejects vlog
    expect(
      createCategoryRequestSchema.safeParse({
        display_name: '테크/IT',
        naver_board_name: 'IT리뷰',
        discovery_mode: 'trend_first',
        datalab_anchor_keyword: '클라우드',
        seed_keywords: ['클라우드'],
        primary_source_domains: ['developers.cloudflare.com'],
        default_media_policy: {
          allowed_content_types: ['explainer', 'experience_review'],
          min_real_photos: 0,
          require_field_memo: false
        },
        default_visibility: '전체공개'
      }).success
    ).toBe(true);

    expect(
      createCategoryRequestSchema.safeParse({
        display_name: '테크/IT',
        naver_board_name: 'IT리뷰',
        discovery_mode: 'trend_first',
        datalab_anchor_keyword: '클라우드',
        seed_keywords: ['클라우드'],
        primary_source_domains: ['developers.cloudflare.com'],
        default_media_policy: {
          allowed_content_types: ['vlog'],
          min_real_photos: 0,
          require_field_memo: false
        },
        default_visibility: '전체공개'
      }).success
    ).toBe(false);

    // experience_first allows only experience_review (rejects explainer and vlog)
    expect(
      createCategoryRequestSchema.safeParse({
        display_name: '맛집',
        naver_board_name: '맛집탐방',
        discovery_mode: 'experience_first',
        datalab_anchor_keyword: '성수동 맛집',
        seed_keywords: ['성수 카페'],
        primary_source_domains: [],
        default_media_policy: {
          allowed_content_types: ['experience_review'],
          min_real_photos: 1,
          require_field_memo: true
        },
        default_visibility: '전체공개'
      }).success
    ).toBe(true);

    expect(
      createCategoryRequestSchema.safeParse({
        display_name: '맛집',
        naver_board_name: '맛집탐방',
        discovery_mode: 'experience_first',
        datalab_anchor_keyword: '성수동 맛집',
        seed_keywords: [],
        primary_source_domains: ['example.com'],
        default_media_policy: {
          allowed_content_types: ['explainer'],
          min_real_photos: 0,
          require_field_memo: false
        },
        default_visibility: '전체공개'
      }).success
    ).toBe(false);

    // none allows only vlog without datalab_anchor_keyword
    expect(
      createCategoryRequestSchema.safeParse({
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
      }).success
    ).toBe(true);

    expect(
      createCategoryRequestSchema.safeParse({
        display_name: '일상/브이로그',
        naver_board_name: '일상기록',
        discovery_mode: 'none',
        datalab_anchor_keyword: null,
        seed_keywords: [],
        primary_source_domains: [],
        default_media_policy: {
          allowed_content_types: ['experience_review'],
          min_real_photos: 0,
          require_field_memo: true
        },
        default_visibility: '이웃공개'
      }).success
    ).toBe(false);

    // PATCH schema requires at least one field
    expect(updateCategoryRequestSchema.safeParse({}).success).toBe(false);
    expect(updateCategoryRequestSchema.safeParse({ naver_board_name: '새 게시판' }).success).toBe(true);
  });

  it('allows memo-only captures (0 photos), rejects empty memo + 0 photos, rejects gps fields, and accepts KST taken_at', () => {
    // 0 photos + non-empty memo -> allowed
    const memoOnly = createCaptureRequestSchema.safeParse({
      category_id: 'cat-vlog',
      content_type: 'vlog',
      photos: [],
      field_memo: '오늘 성수동에서 커피를 마셨다.',
      sponsorship: { is_sponsored: false }
    });
    expect(memoOnly.success).toBe(true);

    // 0 photos + whitespace-only memo -> rejected
    const emptyBoth = createCaptureRequestSchema.safeParse({
      category_id: 'cat-vlog',
      content_type: 'vlog',
      photos: [],
      field_memo: '   ',
      sponsorship: { is_sponsored: false }
    });
    expect(emptyBoth.success).toBe(false);

    // 1 photo with KST offset taken_at + empty memo -> allowed
    const photoOnly = createCaptureRequestSchema.safeParse({
      capture_id: 'cap_01',
      category_id: 'cat-food',
      content_type: 'experience_review',
      photos: [
        {
          seq: 1,
          r2_key: 'users/u1/captures/cap_01/1.webp',
          mime_type: 'image/webp',
          byte_size: 120_000,
          taken_at: '2026-11-20T14:30:00+09:00',
          width: 1600,
          height: 1200,
          caption: '아메리카노'
        }
      ],
      field_memo: '',
      sponsorship: { is_sponsored: false }
    });
    expect(photoOnly.success).toBe(true);

    // GPS fields or store_location_consent=true -> rejected
    const withGpsRoot = createCaptureRequestSchema.safeParse({
      category_id: 'cat-food',
      content_type: 'experience_review',
      photos: [],
      field_memo: '메모',
      gps: { lat: 37.5, lng: 127.0 }
    });
    expect(withGpsRoot.success).toBe(false);

    const withGpsPhoto = createCaptureRequestSchema.safeParse({
      category_id: 'cat-food',
      content_type: 'experience_review',
      photos: [
        {
          seq: 1,
          r2_key: 'users/u1/captures/cap_02/1.webp',
          mime_type: 'image/webp',
          byte_size: 80_000,
          taken_at: null,
          width: 800,
          height: 600,
          caption: '사진',
          gps: { lat: 37.5, lng: 127.0 }
        }
      ],
      field_memo: ''
    });
    expect(withGpsPhoto.success).toBe(false);

    const withLocationConsentTrue = createCaptureRequestSchema.safeParse({
      category_id: 'cat-food',
      content_type: 'experience_review',
      photos: [],
      field_memo: '메모',
      store_location_consent: true
    });
    expect(withLocationConsentTrue.success).toBe(false);

    // captureAssetSchema also accepts 0 photos + memo
    const assetParsed = captureAssetSchema.safeParse({
      capture_id: 'cap_memo_1',
      category_id: 'cat-vlog',
      content_type: 'vlog',
      photos: [],
      field_memo: '메모 단독 캡처',
      sponsorship: { is_sponsored: false },
      store_location_consent: false,
      llm_consent_at: null,
      created_at: '2026-11-20T00:00:00.000Z',
      updated_at: '2026-11-20T00:00:00.000Z'
    });
    expect(assetParsed.success).toBe(true);

    expect(llmConsentRequestSchema.safeParse({ acknowledged_free_tier_training: true }).success).toBe(true);
    expect(llmConsentRequestSchema.safeParse({ acknowledged_free_tier_training: false }).success).toBe(false);
  });

  it('rejects explainer topic without primary source snapshots', () => {
    const res = topicDiscoverySchema.safeParse({
      topic_id: 't1',
      run_id: 'r1',
      track: 'category_discovery',
      category_id: 'tech',
      content_type: 'explainer',
      keyword: 'Cloudflare D1',
      capture_ids: [],
      sources: [],
      ymyl_status: 'SAFE',
      sponsorship: { is_sponsored: false },
      datalab_demand_index: 50,
      blog_supply_count: 100,
      news_supply_count: 5,
      monthly_search_volume: null,
      competition_score: null,
      created_at: '2026-11-20T00:00:00.000Z'
    });
    expect(res.success).toBe(false);
  });

  it('exposes Phase 1.5 error codes without legacy UID_NOT_ALLOWED', () => {
    expect(API_ERROR_CODES).toContain('USER_NOT_REGISTERED');
    expect(API_ERROR_CODES).toContain('USER_BLOCKED');
    expect(API_ERROR_CODES).toContain('ADMIN_ONLY');
    expect(API_ERROR_CODES).toContain('USER_ALREADY_EXISTS');
    expect(API_ERROR_CODES).toContain('NOT_FOUND');
    expect(API_ERROR_CODES).not.toContain('UID_NOT_ALLOWED');
  });

  it('validates meResponseSchema with role and exportResponseSchema with user_meta only', () => {
    const validMe = meResponseSchema.safeParse({
      uid: 'owner-uid-1',
      email: 'owner@example.com',
      role: 'admin',
      auth_time: 1732000000,
      session_expires_at: '2026-12-04T00:00:00.000Z',
      reauth_valid_until: '2026-11-20T00:15:00.000Z',
      d1_connected: true
    });
    expect(validMe.success).toBe(true);

    const missingRoleMe = meResponseSchema.safeParse({
      uid: 'owner-uid-1',
      email: 'owner@example.com',
      auth_time: 1732000000,
      session_expires_at: '2026-12-04T00:00:00.000Z',
      reauth_valid_until: '2026-11-20T00:15:00.000Z',
      d1_connected: true
    });
    expect(missingRoleMe.success).toBe(false);

    const validExport = exportResponseSchema.safeParse({
      exported_at: '2026-11-20T00:00:00.000Z',
      schema_version: '1',
      data: {
        categories: [],
        captures: [],
        topics: [],
        source_snapshots: [],
        manuscripts: [],
        execution_runs: [],
        published_posts: [],
        rank_history: [],
        daily_visitors: [],
        user_meta: []
      }
    });
    expect(validExport.success).toBe(true);

    const legacyExport = exportResponseSchema.safeParse({
      exported_at: '2026-11-20T00:00:00.000Z',
      schema_version: '1',
      data: {
        categories: [],
        captures: [],
        topics: [],
        source_snapshots: [],
        manuscripts: [],
        execution_runs: [],
        quota_ledger: [],
        published_posts: [],
        rank_history: [],
        daily_visitors: [],
        app_meta: []
      }
    });
    expect(legacyExport.success).toBe(false);
  });

  it('validates admin user request and response schemas', () => {
    expect(
      createAdminUserRequestSchema.safeParse({
        uid: '66bOx7EUvXQupsz9tnFSfFvSlJI2',
        label: '테스터 A'
      }).success
    ).toBe(true);

    expect(
      createAdminUserRequestSchema.safeParse({
        uid: 'bad uid with spaces',
        label: '테스터'
      }).success
    ).toBe(false);

    expect(
      createAdminUserRequestSchema.safeParse({
        uid: 'user@example.com',
        label: '이메일 불가'
      }).success
    ).toBe(false);

    expect(updateAdminUserRequestSchema.safeParse({}).success).toBe(false);
    expect(updateAdminUserRequestSchema.safeParse({ label: '새 이름' }).success).toBe(true);
    expect(updateAdminUserRequestSchema.safeParse({ status: 'blocked' }).success).toBe(true);
    expect(updateAdminUserRequestSchema.safeParse({ status: 'deleted' }).success).toBe(false);

    const validList = adminUsersListResponseSchema.safeParse({
      windowDate: '2026-11-23',
      users: [
        {
          uid: 'owner-uid-1',
          label: '관리자 (ADMIN_UIDS)',
          status: 'active',
          role: 'admin',
          createdAt: null,
          updatedAt: null,
          statusChangedAt: null,
          todayUsage: {
            date: '2026-11-23',
            totalCalls: 12,
            byProvider: { naver_search: 10, gemini: 2 }
          }
        },
        {
          uid: 'user-alpha-1',
          label: '사용자 A',
          status: 'active',
          role: 'user',
          createdAt: '2026-11-23T01:00:00.000Z',
          updatedAt: '2026-11-23T01:00:00.000Z',
          statusChangedAt: '2026-11-23T01:00:00.000Z',
          todayUsage: {
            date: '2026-11-23',
            totalCalls: 0,
            byProvider: {}
          }
        }
      ]
    });
    expect(validList.success).toBe(true);
  });
});
