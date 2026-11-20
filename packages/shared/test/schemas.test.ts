import { describe, expect, it } from 'vitest';
import {
  capturePresignRequestSchema,
  categoryProfileSchema,
  topicDiscoverySchema
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
});
