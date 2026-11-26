import type { D1Database } from '@cloudflare/workers-types';
import {
  stripHtmlToPlainText,
  type ContentType,
  type ManuscriptSummary,
  type NaverBlogManuscriptBundle
} from '@content-desk/shared';
import type { UserScope } from '../env.js';

export interface ManuscriptRecord {
  manuscript: NaverBlogManuscriptBundle;
  category_id: string;
  content_type: ContentType;
  run_id: string;
  unresolved_verify_count: number;
  created_at: string;
  updated_at: string;
}

interface ManuscriptDbRow {
  manuscript_id: string;
  owner_uid: string;
  topic_id: string;
  category_id: string;
  content_type: ContentType;
  run_id: string;
  version: number;
  content_hash: string;
  approved_hash: string | null;
  approved_at: string | null;
  unresolved_verify_count: number;
  bundle_json: string;
  created_at: string;
  updated_at: string;
}

export interface ManuscriptRunRow {
  run_id: string;
  owner_uid: string;
  kind: string;
  status: string;
  state_json: string;
}

function hydrateManuscriptRow(row: ManuscriptDbRow): ManuscriptRecord {
  const parsed = JSON.parse(row.bundle_json) as NaverBlogManuscriptBundle;
  const manuscript: NaverBlogManuscriptBundle = {
    ...parsed,
    manuscript_id: row.manuscript_id,
    topic_id: row.topic_id,
    version: row.version,
    content_hash: row.content_hash,
    sanitized_at: parsed.sanitized_at ?? null,
    approved_hash: row.approved_hash,
    approved_at: row.approved_at
  };

  return {
    manuscript,
    category_id: row.category_id,
    content_type: row.content_type,
    run_id: row.run_id,
    unresolved_verify_count: row.unresolved_verify_count,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * LLM 호출 전 execution_runs에 run_id를 원자 선점(INSERT ... ON CONFLICT DO NOTHING).
 * changes === 1일 때만 호출자가 생성 권한을 획득합니다.
 */
export async function claimManuscriptRunIdAtomic(
  scope: UserScope,
  db: D1Database,
  params: {
    runId: string;
    topicId: string;
    nowIso: string;
  }
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO execution_runs (run_id, owner_uid, kind, status, state_json, created_at, updated_at)
       VALUES (?, ?, 'manuscript_generate', 'IN_PROGRESS', ?, ?, ?)
       ON CONFLICT(run_id) DO NOTHING`
    )
    .bind(
      params.runId,
      scope.uid,
      JSON.stringify({ topic_id: params.topicId }),
      params.nowIso,
      params.nowIso
    )
    .run();

  return (res.meta?.changes ?? 0) === 1;
}

export async function getOwnManuscriptRun(
  scope: UserScope,
  db: D1Database,
  runId: string
): Promise<ManuscriptRunRow | null> {
  const row = await db
    .prepare(
      `SELECT run_id, owner_uid, kind, status, state_json
       FROM execution_runs
       WHERE owner_uid = ? AND run_id = ?`
    )
    .bind(scope.uid, runId)
    .first<ManuscriptRunRow>();
  return row ?? null;
}

/**
 * 생성 도중 실패 시 선점한 IN_PROGRESS run_id를 해제해 동일 run_id 재시도를 허용합니다.
 */
export async function releaseFailedManuscriptRun(
  scope: UserScope,
  db: D1Database,
  runId: string
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM execution_runs
       WHERE owner_uid = ? AND run_id = ? AND kind = 'manuscript_generate' AND status = 'IN_PROGRESS'`
    )
    .bind(scope.uid, runId)
    .run();
}

export async function getManuscriptByRunId(
  scope: UserScope,
  db: D1Database,
  runId: string
): Promise<ManuscriptRecord | null> {
  const row = await db
    .prepare(
      `SELECT manuscript_id, owner_uid, topic_id, category_id, content_type, run_id,
              version, content_hash, approved_hash, approved_at,
              unresolved_verify_count, bundle_json, created_at, updated_at
       FROM manuscripts
       WHERE owner_uid = ? AND run_id = ?`
    )
    .bind(scope.uid, runId)
    .first<ManuscriptDbRow>();

  return row ? hydrateManuscriptRow(row) : null;
}

export async function getManuscriptById(
  scope: UserScope,
  db: D1Database,
  manuscriptId: string
): Promise<ManuscriptRecord | null> {
  const row = await db
    .prepare(
      `SELECT manuscript_id, owner_uid, topic_id, category_id, content_type, run_id,
              version, content_hash, approved_hash, approved_at,
              unresolved_verify_count, bundle_json, created_at, updated_at
       FROM manuscripts
       WHERE owner_uid = ? AND manuscript_id = ?`
    )
    .bind(scope.uid, manuscriptId)
    .first<ManuscriptDbRow>();

  return row ? hydrateManuscriptRow(row) : null;
}

export async function listManuscripts(
  scope: UserScope,
  db: D1Database,
  options?: { categoryId?: string; limit?: number }
): Promise<ManuscriptSummary[]> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
  const clauses = ['owner_uid = ?'];
  const binds: unknown[] = [scope.uid];

  if (options?.categoryId) {
    clauses.push('category_id = ?');
    binds.push(options.categoryId);
  }
  binds.push(limit);

  const result = await db
    .prepare(
      `SELECT manuscript_id, owner_uid, topic_id, category_id, content_type, run_id,
              version, content_hash, approved_hash, approved_at,
              unresolved_verify_count, bundle_json, created_at, updated_at
       FROM manuscripts
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(...binds)
    .all<ManuscriptDbRow>();

  return (result.results ?? []).map((row) => {
    const hydrated = hydrateManuscriptRow(row);
    return {
      manuscript_id: hydrated.manuscript.manuscript_id,
      topic_id: hydrated.manuscript.topic_id,
      category_id: hydrated.category_id,
      content_type: hydrated.content_type,
      run_id: hydrated.run_id,
      version: hydrated.manuscript.version,
      selected_title: hydrated.manuscript.selected_title,
      content_hash: hydrated.manuscript.content_hash,
      approved_hash: hydrated.manuscript.approved_hash,
      approved_at: hydrated.manuscript.approved_at,
      unresolved_verify_count: hydrated.unresolved_verify_count,
      created_at: hydrated.created_at,
      updated_at: hydrated.updated_at
    };
  });
}

export async function listApprovedManuscriptTextsForNgram(
  scope: UserScope,
  db: D1Database,
  excludeManuscriptId: string,
  limit = 20
): Promise<Array<{ manuscript_id: string; selected_title: string; body_text: string }>> {
  const result = await db
    .prepare(
      `SELECT manuscript_id, bundle_json
       FROM manuscripts
       WHERE owner_uid = ?
         AND approved_at IS NOT NULL
         AND manuscript_id != ?
       ORDER BY approved_at DESC
       LIMIT ?`
    )
    .bind(scope.uid, excludeManuscriptId, limit)
    .all<{ manuscript_id: string; bundle_json: string }>();

  return (result.results ?? []).map((row) => {
    const parsed = JSON.parse(row.bundle_json) as Partial<NaverBlogManuscriptBundle>;
    return {
      manuscript_id: row.manuscript_id,
      selected_title: parsed.selected_title ?? '',
      body_text: stripHtmlToPlainText(parsed.body_html ?? '')
    };
  });
}

/**
 * 원고 저장 + 선점된 execution_runs 완료 처리를 단일 batch()로 실행합니다.
 */
export async function createManuscriptAndCompleteRun(
  scope: UserScope,
  db: D1Database,
  record: ManuscriptRecord
): Promise<ManuscriptRecord> {
  const { manuscript } = record;
  await db.batch([
    db
      .prepare(
        `INSERT INTO manuscripts (
           manuscript_id, owner_uid, topic_id, category_id, content_type, run_id,
           version, content_hash, approved_hash, approved_at,
           unresolved_verify_count, bundle_json, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        manuscript.manuscript_id,
        scope.uid,
        manuscript.topic_id,
        record.category_id,
        record.content_type,
        record.run_id,
        manuscript.version,
        manuscript.content_hash,
        manuscript.approved_hash,
        manuscript.approved_at,
        record.unresolved_verify_count,
        JSON.stringify(manuscript),
        record.created_at,
        record.updated_at
      ),
    db
      .prepare(
        `UPDATE execution_runs
         SET status = 'COMPLETED',
             state_json = ?,
             updated_at = ?
         WHERE owner_uid = ? AND run_id = ?`
      )
      .bind(
        JSON.stringify({
          topic_id: manuscript.topic_id,
          manuscript_id: manuscript.manuscript_id
        }),
        record.updated_at,
        scope.uid,
        record.run_id
      )
  ]);

  return record;
}

/**
 * 원고 수정/대조 반영 저장:
 * - approved_hash·approved_at을 명시적으로 NULL로 초기화해 수정 시 기존 승인을 자동 해제합니다.
 * - Phase 5(M2) 0003_bridge.sql 적용 후에는 같은 batch() 안에서 QUEUED 브리지 작업 취소문을 추가합니다.
 */
export async function updateManuscriptAndClearApproval(
  scope: UserScope,
  db: D1Database,
  params: {
    manuscript: NaverBlogManuscriptBundle;
    unresolvedVerifyCount: number;
    nowIso: string;
  }
): Promise<boolean> {
  const cleared: NaverBlogManuscriptBundle = {
    ...params.manuscript,
    approved_hash: null,
    approved_at: null
  };

  const res = await db
    .prepare(
      `UPDATE manuscripts
       SET version = ?,
           content_hash = ?,
           approved_hash = NULL,
           approved_at = NULL,
           unresolved_verify_count = ?,
           bundle_json = ?,
           updated_at = ?
       WHERE owner_uid = ? AND manuscript_id = ?`
    )
    .bind(
      cleared.version,
      cleared.content_hash,
      params.unresolvedVerifyCount,
      JSON.stringify(cleared),
      params.nowIso,
      scope.uid,
      cleared.manuscript_id
    )
    .run();

  return (res.meta?.changes ?? 0) === 1;
}

/**
 * 조건부 원고 승인:
 * - owner_uid, manuscript_id, content_hash 일치 및 unresolved_verify_count = 0인 경우에만 승인을 기록합니다.
 */
export async function approveManuscriptConditional(
  scope: UserScope,
  db: D1Database,
  params: {
    manuscriptId: string;
    expectedHash: string;
    approvedAtIso: string;
    updatedBundle: NaverBlogManuscriptBundle;
  }
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE manuscripts
       SET approved_hash = ?,
           approved_at = ?,
           bundle_json = ?,
           updated_at = ?
       WHERE owner_uid = ?
         AND manuscript_id = ?
         AND content_hash = ?
         AND unresolved_verify_count = 0`
    )
    .bind(
      params.expectedHash,
      params.approvedAtIso,
      JSON.stringify(params.updatedBundle),
      params.approvedAtIso,
      scope.uid,
      params.manuscriptId,
      params.expectedHash
    )
    .run();

  return (res.meta?.changes ?? 0) === 1;
}
