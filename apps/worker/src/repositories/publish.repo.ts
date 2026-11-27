import type { D1Database } from '@cloudflare/workers-types';
import type {
  DailyVisitorItem,
  NaverBlogManuscriptBundle,
  PublishedPostItem,
  RankHistoryItem
} from '@content-desk/shared';
import type { UserScope } from '../env.js';

interface PublishedPostJoinedRow {
  post_id: string;
  owner_uid: string;
  manuscript_id: string;
  category_id: string;
  log_no: string;
  post_url: string;
  target_keywords_json: string;
  published_at: string;
  track_until: string;
  last_tracked_date: string | null;
  manuscript_bundle_json: string | null;
  category_display_name: string | null;
}

interface RankHistoryRow {
  id: string;
  owner_uid: string;
  post_id: string;
  keyword: string;
  rank: number | null;
  checked_date: string;
  checked_at: string;
}

interface DailyVisitorRow {
  owner_uid: string;
  visit_date: string;
  visitor_count: number;
  updated_at: string;
}

export interface CategoryCountRow {
  category_id: string;
  display_name: string;
  cnt: number;
}

export interface ApprovalStatsKst {
  todayCount: number;
  weekCount: number;
  totalApprovedCount: number;
}

function parseKeywordsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    }
  } catch {
    // ignore corrupt JSON
  }
  return [];
}

function extractManuscriptTitle(bundleJson: string | null): string {
  if (!bundleJson) return '';
  try {
    const parsed = JSON.parse(bundleJson) as Partial<NaverBlogManuscriptBundle>;
    return typeof parsed.selected_title === 'string' ? parsed.selected_title : '';
  } catch {
    return '';
  }
}

function hydratePublishedPost(
  row: PublishedPostJoinedRow,
  history: RankHistoryItem[]
): PublishedPostItem {
  const latestByKeyword = new Map<string, RankHistoryItem>();
  for (const item of history) {
    if (!latestByKeyword.has(item.keyword)) {
      latestByKeyword.set(item.keyword, item);
    }
  }

  return {
    post_id: row.post_id,
    manuscript_id: row.manuscript_id,
    manuscript_title: extractManuscriptTitle(row.manuscript_bundle_json),
    category_id: row.category_id,
    category_name: row.category_display_name ?? row.category_id,
    log_no: row.log_no,
    post_url: row.post_url,
    target_keywords: parseKeywordsJson(row.target_keywords_json),
    published_at: row.published_at,
    track_until: row.track_until,
    last_tracked_date: row.last_tracked_date,
    latest_ranks: [...latestByKeyword.values()],
    rank_history: history
  };
}

export async function createPublishedPost(
  scope: UserScope,
  db: D1Database,
  params: {
    postId: string;
    manuscriptId: string;
    categoryId: string;
    logNo: string;
    postUrl: string;
    targetKeywords: string[];
    publishedAtIso: string;
    trackUntilYmd: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO published_posts (
         post_id, owner_uid, manuscript_id, category_id, log_no, post_url,
         target_keywords_json, published_at, track_until, last_tracked_date
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .bind(
      params.postId,
      scope.uid,
      params.manuscriptId,
      params.categoryId,
      params.logNo,
      params.postUrl,
      JSON.stringify(params.targetKeywords),
      params.publishedAtIso,
      params.trackUntilYmd
    )
    .run();
}

export async function getPublishedPostById(
  scope: UserScope,
  db: D1Database,
  postId: string
): Promise<PublishedPostItem | null> {
  const [postRow, rankRes] = await Promise.all([
    db
      .prepare(
        `SELECT p.post_id, p.owner_uid, p.manuscript_id, p.category_id, p.log_no, p.post_url,
                p.target_keywords_json, p.published_at, p.track_until, p.last_tracked_date,
                m.bundle_json AS manuscript_bundle_json,
                c.display_name AS category_display_name
         FROM published_posts p
         LEFT JOIN manuscripts m
           ON m.owner_uid = p.owner_uid AND m.manuscript_id = p.manuscript_id
         LEFT JOIN categories c
           ON c.owner_uid = p.owner_uid AND c.category_id = p.category_id
         WHERE p.owner_uid = ? AND p.post_id = ?`
      )
      .bind(scope.uid, postId)
      .first<PublishedPostJoinedRow>(),
    db
      .prepare(
        `SELECT id, owner_uid, post_id, keyword, rank, checked_date, checked_at
         FROM rank_history
         WHERE owner_uid = ? AND post_id = ?
         ORDER BY checked_date DESC, checked_at DESC
         LIMIT 200`
      )
      .bind(scope.uid, postId)
      .all<RankHistoryRow>()
  ]);

  if (!postRow) return null;

  const history: RankHistoryItem[] = (rankRes.results ?? []).map((r) => ({
    id: r.id,
    post_id: r.post_id,
    keyword: r.keyword,
    rank: r.rank,
    checked_date: r.checked_date,
    checked_at: r.checked_at
  }));

  return hydratePublishedPost(postRow, history);
}

export async function listPublishedPostsWithRanks(
  scope: UserScope,
  db: D1Database,
  options?: { limit?: number }
): Promise<PublishedPostItem[]> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);

  const [postsRes, ranksRes] = await Promise.all([
    db
      .prepare(
        `SELECT p.post_id, p.owner_uid, p.manuscript_id, p.category_id, p.log_no, p.post_url,
                p.target_keywords_json, p.published_at, p.track_until, p.last_tracked_date,
                m.bundle_json AS manuscript_bundle_json,
                c.display_name AS category_display_name
         FROM published_posts p
         LEFT JOIN manuscripts m
           ON m.owner_uid = p.owner_uid AND m.manuscript_id = p.manuscript_id
         LEFT JOIN categories c
           ON c.owner_uid = p.owner_uid AND c.category_id = p.category_id
         WHERE p.owner_uid = ?
         ORDER BY p.published_at DESC
         LIMIT ?`
      )
      .bind(scope.uid, limit)
      .all<PublishedPostJoinedRow>(),
    db
      .prepare(
        `SELECT id, owner_uid, post_id, keyword, rank, checked_date, checked_at
         FROM rank_history
         WHERE owner_uid = ?
         ORDER BY checked_date DESC, checked_at DESC
         LIMIT 500`
      )
      .bind(scope.uid)
      .all<RankHistoryRow>()
  ]);

  const ranksByPost = new Map<string, RankHistoryItem[]>();
  for (const r of ranksRes.results ?? []) {
    const list = ranksByPost.get(r.post_id) ?? [];
    list.push({
      id: r.id,
      post_id: r.post_id,
      keyword: r.keyword,
      rank: r.rank,
      checked_date: r.checked_date,
      checked_at: r.checked_at
    });
    ranksByPost.set(r.post_id, list);
  }

  return (postsRes.results ?? []).map((row) =>
    hydratePublishedPost(row, ranksByPost.get(row.post_id) ?? [])
  );
}

export async function upsertDailyVisitor(
  scope: UserScope,
  db: D1Database,
  params: {
    visitDate: string;
    visitorCount: number;
    nowIso: string;
  }
): Promise<DailyVisitorItem> {
  await db
    .prepare(
      `INSERT INTO daily_visitors (owner_uid, visit_date, visitor_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_uid, visit_date)
       DO UPDATE SET visitor_count = excluded.visitor_count,
                     updated_at = excluded.updated_at`
    )
    .bind(scope.uid, params.visitDate, params.visitorCount, params.nowIso)
    .run();

  return {
    visit_date: params.visitDate,
    visitor_count: params.visitorCount,
    updated_at: params.nowIso
  };
}

export async function listDailyVisitors(
  scope: UserScope,
  db: D1Database,
  options?: { limit?: number }
): Promise<DailyVisitorItem[]> {
  const limit = Math.min(Math.max(options?.limit ?? 60, 1), 365);
  const res = await db
    .prepare(
      `SELECT owner_uid, visit_date, visitor_count, updated_at
       FROM daily_visitors
       WHERE owner_uid = ?
       ORDER BY visit_date DESC
       LIMIT ?`
    )
    .bind(scope.uid, limit)
    .all<DailyVisitorRow>();

  return (res.results ?? []).map((row) => ({
    visit_date: row.visit_date,
    visitor_count: row.visitor_count,
    updated_at: row.updated_at
  }));
}

export async function getApprovalStatsKst(
  scope: UserScope,
  db: D1Database,
  params: {
    kstTodayStartUtcIso: string;
    kstWeekStartUtcIso: string;
  }
): Promise<ApprovalStatsKst> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN approved_at >= ? THEN 1 ELSE 0 END) AS today_count,
         SUM(CASE WHEN approved_at >= ? THEN 1 ELSE 0 END) AS week_count,
         COUNT(*) AS total_approved_count
       FROM manuscripts
       WHERE owner_uid = ?
         AND approved_at IS NOT NULL
         AND approved_hash IS NOT NULL
         AND approved_hash = content_hash`
    )
    .bind(params.kstTodayStartUtcIso, params.kstWeekStartUtcIso, scope.uid)
    .first<{
      today_count: number | null;
      week_count: number | null;
      total_approved_count: number | null;
    }>();

  return {
    todayCount: Number(row?.today_count ?? 0),
    weekCount: Number(row?.week_count ?? 0),
    totalApprovedCount: Number(row?.total_approved_count ?? 0)
  };
}

export async function countOwnerPublishedPosts(
  scope: UserScope,
  db: D1Database
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS cnt FROM published_posts WHERE owner_uid = ?')
    .bind(scope.uid)
    .first<{ cnt: number }>();
  return Number(row?.cnt ?? 0);
}

export async function getCRankCategoryDistribution(
  scope: UserScope,
  db: D1Database,
  sinceUtcIso: string
): Promise<{
  basis: 'published_posts' | 'approved_manuscripts' | 'none';
  rows: CategoryCountRow[];
}> {
  const publishedRes = await db
    .prepare(
      `SELECT p.category_id AS category_id,
              COALESCE(c.display_name, p.category_id) AS display_name,
              COUNT(*) AS cnt
       FROM published_posts p
       LEFT JOIN categories c
         ON c.owner_uid = p.owner_uid AND c.category_id = p.category_id
       WHERE p.owner_uid = ?
         AND p.published_at >= ?
       GROUP BY p.category_id, c.display_name
       ORDER BY cnt DESC, p.category_id ASC`
    )
    .bind(scope.uid, sinceUtcIso)
    .all<CategoryCountRow>();

  const publishedRows = (publishedRes.results ?? []).map((r) => ({
    category_id: r.category_id,
    display_name: r.display_name,
    cnt: Number(r.cnt)
  }));

  if (publishedRows.length > 0) {
    return { basis: 'published_posts', rows: publishedRows };
  }

  const approvedRes = await db
    .prepare(
      `SELECT m.category_id AS category_id,
              COALESCE(c.display_name, m.category_id) AS display_name,
              COUNT(*) AS cnt
       FROM manuscripts m
       LEFT JOIN categories c
         ON c.owner_uid = m.owner_uid AND c.category_id = m.category_id
       WHERE m.owner_uid = ?
         AND m.approved_at IS NOT NULL
         AND m.approved_hash IS NOT NULL
         AND m.approved_hash = m.content_hash
         AND m.approved_at >= ?
       GROUP BY m.category_id, c.display_name
       ORDER BY cnt DESC, m.category_id ASC`
    )
    .bind(scope.uid, sinceUtcIso)
    .all<CategoryCountRow>();

  const approvedRows = (approvedRes.results ?? []).map((r) => ({
    category_id: r.category_id,
    display_name: r.display_name,
    cnt: Number(r.cnt)
  }));

  if (approvedRows.length > 0) {
    return { basis: 'approved_manuscripts', rows: approvedRows };
  }

  return { basis: 'none', rows: [] };
}
