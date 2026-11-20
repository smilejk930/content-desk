import { Hono } from 'hono';
import type { WorkerEnv } from '../env.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import { requireRecentAuth } from '../middleware/recent-auth.js';

export const exportRoute = new Hono<WorkerEnv>().post(
  '/',
  firebaseAuth,
  requireRecentAuth,
  async (c) => {
    const nowIso = new Date().toISOString();

    // 먼저 마지막 전체 내보내기 시각(last_full_export_at — Phase 4 30일 백업 알림 기준 키)을 기록한 뒤
    // 모든 영속 테이블을 batch()로 일관 조회합니다.
    // 제외 테이블: api_cache(외부 API 단기 캐시·백오프 시각으로 재생성 가능한 휘발성 데이터).
    const [
      ,
      categories,
      captures,
      topics,
      sourceSnapshots,
      manuscripts,
      executionRuns,
      quotaLedger,
      publishedPosts,
      rankHistory,
      dailyVisitors,
      appMeta
    ] = await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      ).bind('last_full_export_at', nowIso, nowIso),
      c.env.DB.prepare('SELECT * FROM categories ORDER BY created_at DESC'),
      c.env.DB.prepare('SELECT * FROM captures ORDER BY created_at DESC'),
      c.env.DB.prepare('SELECT * FROM topics ORDER BY created_at DESC'),
      c.env.DB.prepare('SELECT * FROM source_snapshots ORDER BY fetched_at DESC'),
      c.env.DB.prepare('SELECT * FROM manuscripts ORDER BY created_at DESC'),
      c.env.DB.prepare('SELECT * FROM execution_runs ORDER BY created_at DESC'),
      c.env.DB.prepare('SELECT * FROM quota_ledger ORDER BY window_date DESC, provider ASC'),
      c.env.DB.prepare('SELECT * FROM published_posts ORDER BY published_at DESC'),
      c.env.DB.prepare('SELECT * FROM rank_history ORDER BY checked_date DESC, checked_at DESC'),
      c.env.DB.prepare('SELECT * FROM daily_visitors ORDER BY visit_date DESC'),
      c.env.DB.prepare('SELECT * FROM app_meta ORDER BY key ASC')
    ]);

    return c.json({
      exported_at: nowIso,
      schema_version: '1' as const,
      data: {
        categories: categories?.results ?? [],
        captures: captures?.results ?? [],
        topics: topics?.results ?? [],
        source_snapshots: sourceSnapshots?.results ?? [],
        manuscripts: manuscripts?.results ?? [],
        execution_runs: executionRuns?.results ?? [],
        quota_ledger: quotaLedger?.results ?? [],
        published_posts: publishedPosts?.results ?? [],
        rank_history: rankHistory?.results ?? [],
        daily_visitors: dailyVisitors?.results ?? [],
        app_meta: appMeta?.results ?? []
      }
    });
  }
);
