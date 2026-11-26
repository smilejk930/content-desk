import type { D1Database } from '@cloudflare/workers-types';
import type {
  PrimarySourceRef,
  TopicDiscoveryJSON,
  TopicStatus,
  YmylStatus
} from '@content-desk/shared';
import type { UserScope } from '../env.js';
import { AppError } from '../middleware/error-handler.js';

interface TopicDbRow {
  topic_id: string;
  owner_uid: string;
  run_id: string;
  track: TopicDiscoveryJSON['track'];
  category_id: string;
  content_type: TopicDiscoveryJSON['content_type'];
  status: TopicStatus;
  ymyl_status: YmylStatus;
  topic_json: string;
  created_at: string;
  updated_at: string;
}

export interface TopicWithVersion {
  topic: TopicDiscoveryJSON;
  updatedAt: string;
}

export interface ExecutionRunDbRow {
  run_id: string;
  owner_uid: string;
  kind: string;
  status: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}

export interface SourceSnapshotDbRow {
  snapshot_id: string;
  owner_uid: string;
  topic_id: string;
  url: string;
  domain: string;
  ingest_channel: 'webkr_search' | 'manual_input';
  r2_key: string;
  body_sha256: string;
  char_count: number;
  fetched_at: string;
}

function hydrateTopicRow(row: TopicDbRow): TopicDiscoveryJSON {
  const parsed = JSON.parse(row.topic_json) as Partial<TopicDiscoveryJSON>;
  return {
    topic_id: row.topic_id,
    run_id: row.run_id,
    track: row.track,
    category_id: row.category_id,
    content_type: row.content_type,
    status: row.status,
    keyword: parsed.keyword ?? '',
    capture_ids: parsed.capture_ids ?? [],
    sources: parsed.sources ?? [],
    ymyl_status: row.ymyl_status,
    ymyl_reason: parsed.ymyl_reason ?? null,
    sponsorship: parsed.sponsorship ?? { is_sponsored: false },
    datalab_demand_index: parsed.datalab_demand_index ?? null,
    blog_supply_count: parsed.blog_supply_count ?? null,
    news_supply_count: parsed.news_supply_count ?? null,
    monthly_search_volume: parsed.monthly_search_volume ?? null,
    competition_score: parsed.competition_score ?? null,
    serp_snippets: parsed.serp_snippets ?? [],
    created_at: row.created_at
  };
}

export async function getExecutionRunById(
  scope: UserScope,
  db: D1Database,
  runId: string
): Promise<ExecutionRunDbRow | null> {
  const row = await db
    .prepare(
      `SELECT run_id, owner_uid, kind, status, state_json, created_at, updated_at
       FROM execution_runs
       WHERE owner_uid = ? AND run_id = ?`
    )
    .bind(scope.uid, runId)
    .first<ExecutionRunDbRow>();
  return row ?? null;
}

/**
 * 실행 원장 업서트:
 * 다른 사용자의 run_id와 충돌해 변경 행 수가 0이면 조용히 넘어가지 않고 409 CONFLICT를 반환합니다.
 */
export async function upsertExecutionRun(
  scope: UserScope,
  db: D1Database,
  params: {
    runId: string;
    kind: string;
    status: string;
    state: Record<string, unknown>;
    nowIso: string;
  }
): Promise<void> {
  const res = await db
    .prepare(
      `INSERT INTO execution_runs (run_id, owner_uid, kind, status, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id)
       DO UPDATE SET status = excluded.status,
                     state_json = excluded.state_json,
                     updated_at = excluded.updated_at
       WHERE execution_runs.owner_uid = ?`
    )
    .bind(
      params.runId,
      scope.uid,
      params.kind,
      params.status,
      JSON.stringify(params.state),
      params.nowIso,
      params.nowIso,
      scope.uid
    )
    .run();

  if ((res.meta?.changes ?? 0) === 0) {
    throw new AppError(409, 'CONFLICT', '이미 다른 실행에서 사용 중인 run_id입니다.');
  }
}

export async function createTopicsBatch(
  scope: UserScope,
  db: D1Database,
  topics: readonly TopicDiscoveryJSON[],
  nowIso: string
): Promise<void> {
  if (topics.length === 0) return;

  const statements = topics.map((topic) =>
    db
      .prepare(
        `INSERT INTO topics (
           topic_id, owner_uid, run_id, track, category_id, content_type,
           status, ymyl_status, topic_json, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        topic.topic_id,
        scope.uid,
        topic.run_id,
        topic.track,
        topic.category_id,
        topic.content_type,
        topic.status,
        topic.ymyl_status,
        JSON.stringify(topic),
        topic.created_at,
        nowIso
      )
  );

  await db.batch(statements);
}

export async function createTopic(
  scope: UserScope,
  db: D1Database,
  topic: TopicDiscoveryJSON,
  nowIso: string
): Promise<TopicDiscoveryJSON> {
  await db
    .prepare(
      `INSERT INTO topics (
         topic_id, owner_uid, run_id, track, category_id, content_type,
         status, ymyl_status, topic_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      topic.topic_id,
      scope.uid,
      topic.run_id,
      topic.track,
      topic.category_id,
      topic.content_type,
      topic.status,
      topic.ymyl_status,
      JSON.stringify(topic),
      topic.created_at,
      nowIso
    )
    .run();
  return topic;
}

export async function listTopicsWithVersion(
  scope: UserScope,
  db: D1Database,
  options?: { categoryId?: string; runId?: string; status?: string; limit?: number }
): Promise<TopicWithVersion[]> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
  const clauses: string[] = ['owner_uid = ?'];
  const binds: unknown[] = [scope.uid];

  if (options?.categoryId) {
    clauses.push('category_id = ?');
    binds.push(options.categoryId);
  }
  if (options?.runId) {
    clauses.push('run_id = ?');
    binds.push(options.runId);
  }
  if (options?.status) {
    clauses.push('status = ?');
    binds.push(options.status);
  }
  binds.push(limit);

  const result = await db
    .prepare(
      `SELECT topic_id, owner_uid, run_id, track, category_id, content_type,
              status, ymyl_status, topic_json, created_at, updated_at
       FROM topics
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(...binds)
    .all<TopicDbRow>();

  return (result.results ?? []).map((row) => ({
    topic: hydrateTopicRow(row),
    updatedAt: row.updated_at
  }));
}

export async function listTopics(
  scope: UserScope,
  db: D1Database,
  options?: { categoryId?: string; runId?: string; status?: string; limit?: number }
): Promise<TopicDiscoveryJSON[]> {
  const rows = await listTopicsWithVersion(scope, db, options);
  return rows.map((r) => r.topic);
}

export async function getTopicWithVersion(
  scope: UserScope,
  db: D1Database,
  topicId: string
): Promise<TopicWithVersion | null> {
  const row = await db
    .prepare(
      `SELECT topic_id, owner_uid, run_id, track, category_id, content_type,
              status, ymyl_status, topic_json, created_at, updated_at
       FROM topics
       WHERE owner_uid = ? AND topic_id = ?`
    )
    .bind(scope.uid, topicId)
    .first<TopicDbRow>();

  return row ? { topic: hydrateTopicRow(row), updatedAt: row.updated_at } : null;
}

export async function getTopicById(
  scope: UserScope,
  db: D1Database,
  topicId: string
): Promise<TopicDiscoveryJSON | null> {
  const found = await getTopicWithVersion(scope, db, topicId);
  return found ? found.topic : null;
}

/**
 * 낙관적 잠금(WHERE owner_uid = ? AND topic_id = ? AND updated_at = ?) 기반 단건 토픽 갱신.
 */
export async function updateTopicOptimistic(
  scope: UserScope,
  db: D1Database,
  params: {
    topic: TopicDiscoveryJSON;
    expectedUpdatedAt: string;
    nowIso: string;
  }
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE topics
       SET status = ?,
           ymyl_status = ?,
           topic_json = ?,
           updated_at = ?
       WHERE owner_uid = ? AND topic_id = ? AND updated_at = ?`
    )
    .bind(
      params.topic.status,
      params.topic.ymyl_status,
      JSON.stringify(params.topic),
      params.nowIso,
      scope.uid,
      params.topic.topic_id,
      params.expectedUpdatedAt
    )
    .run();

  return (res.meta?.changes ?? 0) === 1;
}

/**
 * 낙관적 잠금 기반 배치 토픽 갱신. 하나라도 동시 수정으로 변경 행이 0이면 false 반환.
 */
export async function updateTopicsBatchOptimistic(
  scope: UserScope,
  db: D1Database,
  items: ReadonlyArray<{ topic: TopicDiscoveryJSON; expectedUpdatedAt: string }>,
  nowIso: string
): Promise<boolean> {
  if (items.length === 0) return true;
  const statements = items.map(({ topic, expectedUpdatedAt }) =>
    db
      .prepare(
        `UPDATE topics
         SET status = ?,
             ymyl_status = ?,
             topic_json = ?,
             updated_at = ?
         WHERE owner_uid = ? AND topic_id = ? AND updated_at = ?`
      )
      .bind(
        topic.status,
        topic.ymyl_status,
        JSON.stringify(topic),
        nowIso,
        scope.uid,
        topic.topic_id,
        expectedUpdatedAt
      )
  );
  const results = await db.batch(statements);
  return results.every((r) => (r.meta?.changes ?? 0) === 1);
}

export async function listSourceSnapshotsByTopic(
  scope: UserScope,
  db: D1Database,
  topicId: string
): Promise<SourceSnapshotDbRow[]> {
  const result = await db
    .prepare(
      `SELECT snapshot_id, owner_uid, topic_id, url, domain, ingest_channel,
              r2_key, body_sha256, char_count, fetched_at
       FROM source_snapshots
       WHERE owner_uid = ? AND topic_id = ?
       ORDER BY fetched_at ASC`
    )
    .bind(scope.uid, topicId)
    .all<SourceSnapshotDbRow>();

  return result.results ?? [];
}

/**
 * 낙관적 잠금 기반 1차 출처 스냅샷 저장 및 토픽 갱신.
 * - updated_at 불일치(동시 수정 충돌) 시 삽입된 source_snapshots 행을 즉시 정리하고 false 반환.
 */
export async function saveSourceSnapshotAndUpdateTopicOptimistic(
  scope: UserScope,
  db: D1Database,
  params: {
    snapshot: PrimarySourceRef & { char_count: number };
    updatedTopic: TopicDiscoveryJSON;
    expectedUpdatedAt: string;
    nowIso: string;
  }
): Promise<boolean> {
  const { snapshot, updatedTopic, expectedUpdatedAt, nowIso } = params;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE topics
         SET status = ?,
             ymyl_status = ?,
             topic_json = ?,
             updated_at = ?
         WHERE owner_uid = ? AND topic_id = ? AND updated_at = ?`
      )
      .bind(
        updatedTopic.status,
        updatedTopic.ymyl_status,
        JSON.stringify(updatedTopic),
        nowIso,
        scope.uid,
        updatedTopic.topic_id,
        expectedUpdatedAt
      ),
    db
      .prepare(
        `INSERT INTO source_snapshots (
           snapshot_id, owner_uid, topic_id, url, domain, ingest_channel,
           r2_key, body_sha256, char_count, fetched_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        snapshot.source_id,
        scope.uid,
        updatedTopic.topic_id,
        snapshot.url,
        snapshot.domain,
        snapshot.ingest_channel,
        snapshot.r2_key,
        snapshot.body_sha256,
        snapshot.char_count,
        snapshot.fetched_at
      )
  ]);

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    // 낙관적 잠금 충돌 시 source_snapshots 고아 행 즉시 보상 삭제
    await db
      .prepare('DELETE FROM source_snapshots WHERE owner_uid = ? AND snapshot_id = ?')
      .bind(scope.uid, snapshot.source_id)
      .run();
    return false;
  }

  return true;
}
