import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('D1 0001_initial.sql 마이그레이션 검증', () => {
  it('creates all 12 M1 tables and required indexes', async () => {
    const tablesRes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'"
    ).all<{ name: string }>();

    const names = tablesRes.results.map((r) => r.name);
    for (const expected of [
      'categories',
      'captures',
      'topics',
      'source_snapshots',
      'manuscripts',
      'execution_runs',
      'quota_ledger',
      'api_cache',
      'published_posts',
      'rank_history',
      'daily_visitors',
      'app_meta'
    ]) {
      expect(names).toContain(expected);
    }

    const idxRes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'"
    ).all<{ name: string }>();
    const idxNames = idxRes.results.map((r) => r.name);
    expect(idxNames).toEqual(
      expect.arrayContaining([
        'idx_captures_category_created',
        'idx_topics_category_status_created',
        'idx_topics_run_id',
        'idx_source_snapshots_topic',
        'idx_manuscripts_approved_at',
        'idx_manuscripts_category_created',
        'idx_published_posts_tracking',
        'idx_published_posts_category_published'
      ])
    );
  });
});
