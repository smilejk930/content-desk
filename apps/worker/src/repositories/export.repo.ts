import type { D1Database } from '@cloudflare/workers-types';
import type { ExportResponse } from '@content-desk/shared';
import type { UserScope } from '../env.js';
import { prepareUpsertUserMeta } from './user-meta.repo.js';

type ExportData = ExportResponse['data'];
type RowRecord = Record<string, unknown>;

export async function exportUserData(
  scope: UserScope,
  db: D1Database,
  exportedAtIso: string
): Promise<ExportData> {
  // last_full_export_at 기록과 본인(owner_uid) 소유의 9개 사용자 데이터 표 + user_meta 조회를
  // 단일 D1 batch() 트랜잭션으로 원자 실행합니다(조회 실패 시 last_full_export_at도 롤백).
  // 제외 표: users, usage_daily, quota_ledger, api_cache, app_meta.
  const [
    ,
    categories,
    captures,
    topics,
    sourceSnapshots,
    manuscripts,
    executionRuns,
    publishedPosts,
    rankHistory,
    dailyVisitors,
    userMeta
  ] = await db.batch([
    prepareUpsertUserMeta(scope, db, 'last_full_export_at', exportedAtIso, exportedAtIso),
    db.prepare('SELECT * FROM categories WHERE owner_uid = ? ORDER BY created_at DESC').bind(scope.uid),
    db.prepare('SELECT * FROM captures WHERE owner_uid = ? ORDER BY created_at DESC').bind(scope.uid),
    db.prepare('SELECT * FROM topics WHERE owner_uid = ? ORDER BY created_at DESC').bind(scope.uid),
    db
      .prepare('SELECT * FROM source_snapshots WHERE owner_uid = ? ORDER BY fetched_at DESC')
      .bind(scope.uid),
    db.prepare('SELECT * FROM manuscripts WHERE owner_uid = ? ORDER BY created_at DESC').bind(scope.uid),
    db
      .prepare('SELECT * FROM execution_runs WHERE owner_uid = ? ORDER BY created_at DESC')
      .bind(scope.uid),
    db
      .prepare('SELECT * FROM published_posts WHERE owner_uid = ? ORDER BY published_at DESC')
      .bind(scope.uid),
    db
      .prepare('SELECT * FROM rank_history WHERE owner_uid = ? ORDER BY checked_date DESC, checked_at DESC')
      .bind(scope.uid),
    db.prepare('SELECT * FROM daily_visitors WHERE owner_uid = ? ORDER BY visit_date DESC').bind(scope.uid),
    db.prepare('SELECT * FROM user_meta WHERE owner_uid = ? ORDER BY key ASC').bind(scope.uid)
  ]);

  return {
    categories: (categories?.results as RowRecord[] | undefined) ?? [],
    captures: (captures?.results as RowRecord[] | undefined) ?? [],
    topics: (topics?.results as RowRecord[] | undefined) ?? [],
    source_snapshots: (sourceSnapshots?.results as RowRecord[] | undefined) ?? [],
    manuscripts: (manuscripts?.results as RowRecord[] | undefined) ?? [],
    execution_runs: (executionRuns?.results as RowRecord[] | undefined) ?? [],
    published_posts: (publishedPosts?.results as RowRecord[] | undefined) ?? [],
    rank_history: (rankHistory?.results as RowRecord[] | undefined) ?? [],
    daily_visitors: (dailyVisitors?.results as RowRecord[] | undefined) ?? [],
    user_meta: (userMeta?.results as RowRecord[] | undefined) ?? []
  };
}
