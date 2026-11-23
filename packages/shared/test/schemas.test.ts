import { describe, expect, it } from 'vitest';
import {
  adminUsersListResponseSchema,
  API_ERROR_CODES,
  capturePresignRequestSchema,
  categoryProfileSchema,
  createAdminUserRequestSchema,
  exportResponseSchema,
  meResponseSchema,
  topicDiscoverySchema,
  updateAdminUserRequestSchema
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
      files: [{ seq: 1, content_type: 'image/png', byte_size: 1024 }],
      extra_field: true
    });
    expect(res.success).toBe(false);
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
