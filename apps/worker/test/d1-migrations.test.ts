import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('D1 0001_initial.sql + 0002_multi_user.sql 마이그레이션 검증', () => {
  it('blocks 0002_multi_user.sql via 0-row CHECK guard and preserves existing tables and rows when any user table is non-empty', async () => {
    const initialMigration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0001_'));
    expect(initialMigration).toBeDefined();

    // Apply only 0001_initial.sql and insert 1 row into categories
    await applyD1Migrations(env.DB, [initialMigration!]);
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO categories (category_id, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
       VALUES ('legacy-cat-1', '기존카테고리', 'trend_first', '키워드', '전체공개', '{}', ?, ?)`
    )
      .bind(nowIso, nowIso)
      .run();

    // Applying 0002_multi_user.sql must fail at the 0-row CHECK guard before any DROP TABLE
    await expect(applyD1Migrations(env.DB, env.TEST_MIGRATIONS)).rejects.toThrow(
      /CHECK constraint failed/i
    );

    // Existing row and 0001 table must remain intact, and temporary _mu_guard must be rolled back
    const existingRow = await env.DB.prepare(
      "SELECT category_id, display_name FROM categories WHERE category_id = 'legacy-cat-1'"
    ).first<{ category_id: string; display_name: string }>();
    expect(existingRow).toEqual({
      category_id: 'legacy-cat-1',
      display_name: '기존카테고리'
    });

    const guardTable = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_mu_guard'"
    ).first<{ name: string }>();
    expect(guardTable).toBeNull();

    // Verify 0001 categories schema is untouched (no owner_uid column yet)
    const cols = await env.DB.prepare("PRAGMA table_info('categories')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).not.toContain('owner_uid');

    // Clean up the seeded legacy row so subsequent tests can apply 0002 cleanly
    await env.DB.prepare("DELETE FROM categories WHERE category_id = 'legacy-cat-1'").run();
  });

  it('cleans up legacy app_meta last_full_export_at while preserving other app_meta keys during 0002_multi_user.sql', async () => {
    const initialMigration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0001_'));
    expect(initialMigration).toBeDefined();

    await applyD1Migrations(env.DB, [initialMigration!]);
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES ('last_full_export_at', ?, ?)`
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES ('global_schema_note', 'keep-me', ?)`
      ).bind(nowIso)
    ]);

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const legacyExportMeta = await env.DB.prepare(
      "SELECT key FROM app_meta WHERE key = 'last_full_export_at'"
    ).first<{ key: string }>();
    expect(legacyExportMeta).toBeNull();

    const keptMeta = await env.DB.prepare(
      "SELECT key, value FROM app_meta WHERE key = 'global_schema_note'"
    ).first<{ key: string; value: string }>();
    expect(keptMeta).toEqual({ key: 'global_schema_note', value: 'keep-me' });
  });

  it('creates all 15 Phase 1.5 tables and owner_uid-leading + cron indexes', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const tablesRes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'"
    ).all<{ name: string }>();

    const names = tablesRes.results.map((r) => r.name).sort();
    expect(names).toEqual([
      'api_cache',
      'app_meta',
      'captures',
      'categories',
      'daily_visitors',
      'execution_runs',
      'manuscripts',
      'published_posts',
      'quota_ledger',
      'rank_history',
      'source_snapshots',
      'topics',
      'usage_daily',
      'user_meta',
      'users'
    ]);

    const idxRes = await env.DB.prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'"
    ).all<{ name: string; tbl_name: string; sql: string }>();
    const idxMap = new Map(idxRes.results.map((r) => [r.name, r]));

    expect(Array.from(idxMap.keys())).toEqual(
      expect.arrayContaining([
        'idx_categories_owner_created',
        'idx_captures_owner_category_created',
        'idx_topics_owner_category_status_created',
        'idx_topics_owner_run_id',
        'idx_source_snapshots_owner_topic',
        'idx_manuscripts_owner_approved_at',
        'idx_manuscripts_owner_category_created',
        'idx_execution_runs_owner_created',
        'idx_published_posts_tracking',
        'idx_published_posts_owner_category_published',
        'idx_rank_history_owner_checked',
        'idx_usage_daily_window_date'
      ])
    );

    // Verify cron tracking index columns & usage_daily cleanup index
    expect(idxMap.get('idx_published_posts_tracking')?.sql).toMatch(
      /\(\s*track_until\s*,\s*last_tracked_date\s*,\s*owner_uid\s*\)/i
    );
    expect(idxMap.get('idx_usage_daily_window_date')?.sql).toMatch(/\(\s*window_date\s*\)/i);

    // Verify all per-user lookup indexes lead with owner_uid
    for (const ownerLeadingIdx of [
      'idx_categories_owner_created',
      'idx_captures_owner_category_created',
      'idx_topics_owner_category_status_created',
      'idx_topics_owner_run_id',
      'idx_source_snapshots_owner_topic',
      'idx_manuscripts_owner_approved_at',
      'idx_manuscripts_owner_category_created',
      'idx_execution_runs_owner_created',
      'idx_published_posts_owner_category_published',
      'idx_rank_history_owner_checked'
    ]) {
      expect(idxMap.get(ownerLeadingIdx)?.sql).toMatch(/\(\s*owner_uid\b/i);
    }
  });

  it('allows identical display_name/log_no/visit_date across different owners and enforces composite foreign keys', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const nowIso = new Date().toISOString();

    // Two distinct owners can share display_name and daily_visitors.visit_date
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('mig-cat-a', 'mig-user-a', '테크/IT', 'trend_first', '클라우드', '전체공개', '{}', ?, ?)`
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO categories (category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword, default_visibility, profile_json, created_at, updated_at)
         VALUES ('mig-cat-b', 'mig-user-b', '테크/IT', 'trend_first', '클라우드', '전체공개', '{}', ?, ?)`
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO daily_visitors (owner_uid, visit_date, visitor_count, updated_at) VALUES ('mig-user-a', '2026-11-23', 10, ?)`
      ).bind(nowIso),
      env.DB.prepare(
        `INSERT INTO daily_visitors (owner_uid, visit_date, visitor_count, updated_at) VALUES ('mig-user-b', '2026-11-23', 20, ?)`
      ).bind(nowIso)
    ]);

    // Same-owner FK succeeds
    await env.DB.prepare(
      `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
       VALUES ('mig-cap-a', 'mig-user-a', 'mig-cat-a', 'experience_review', NULL, '{}', ?, ?)`
    )
      .bind(nowIso, nowIso)
      .run();

    // Cross-owner FK fails
    await expect(
      env.DB.prepare(
        `INSERT INTO captures (capture_id, owner_uid, category_id, content_type, llm_consent_at, capture_json, created_at, updated_at)
         VALUES ('mig-cap-cross', 'mig-user-b', 'mig-cat-a', 'experience_review', NULL, '{}', ?, ?)`
      )
        .bind(nowIso, nowIso)
        .run()
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });
});
