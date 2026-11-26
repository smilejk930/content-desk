import type { D1Database } from '@cloudflare/workers-types';
import type { CaptureAsset } from '@content-desk/shared';
import type { UserScope } from '../env.js';

interface CaptureDbRow {
  capture_id: string;
  owner_uid: string;
  category_id: string;
  content_type: CaptureAsset['content_type'];
  llm_consent_at: string | null;
  capture_json: string;
  created_at: string;
  updated_at: string;
}

function hydrateCaptureRow(row: CaptureDbRow): CaptureAsset {
  const parsed = JSON.parse(row.capture_json) as Partial<CaptureAsset>;
  return {
    capture_id: row.capture_id,
    category_id: row.category_id,
    content_type: row.content_type,
    photos: parsed.photos ?? [],
    field_memo: parsed.field_memo ?? '',
    sponsorship: parsed.sponsorship ?? { is_sponsored: false },
    store_location_consent: false,
    llm_consent_at: row.llm_consent_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function listCaptures(
  scope: UserScope,
  db: D1Database,
  options?: { categoryId?: string; limit?: number }
): Promise<CaptureAsset[]> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);

  if (options?.categoryId) {
    const result = await db
      .prepare(
        `SELECT capture_id, owner_uid, category_id, content_type, llm_consent_at,
                capture_json, created_at, updated_at
         FROM captures
         WHERE owner_uid = ? AND category_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(scope.uid, options.categoryId, limit)
      .all<CaptureDbRow>();
    return (result.results ?? []).map(hydrateCaptureRow);
  }

  const result = await db
    .prepare(
      `SELECT capture_id, owner_uid, category_id, content_type, llm_consent_at,
              capture_json, created_at, updated_at
       FROM captures
       WHERE owner_uid = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(scope.uid, limit)
    .all<CaptureDbRow>();

  return (result.results ?? []).map(hydrateCaptureRow);
}

export async function getCaptureById(
  scope: UserScope,
  db: D1Database,
  captureId: string
): Promise<CaptureAsset | null> {
  const row = await db
    .prepare(
      `SELECT capture_id, owner_uid, category_id, content_type, llm_consent_at,
              capture_json, created_at, updated_at
       FROM captures
       WHERE owner_uid = ? AND capture_id = ?`
    )
    .bind(scope.uid, captureId)
    .first<CaptureDbRow>();

  return row ? hydrateCaptureRow(row) : null;
}

export async function createCapture(
  scope: UserScope,
  db: D1Database,
  capture: CaptureAsset
): Promise<CaptureAsset> {
  await db
    .prepare(
      `INSERT INTO captures (
         capture_id, owner_uid, category_id, content_type,
         llm_consent_at, capture_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      capture.capture_id,
      scope.uid,
      capture.category_id,
      capture.content_type,
      capture.llm_consent_at,
      JSON.stringify(capture),
      capture.created_at,
      capture.updated_at
    )
    .run();

  return capture;
}

export async function recordCaptureLlmConsent(
  scope: UserScope,
  db: D1Database,
  captureId: string,
  consentAtIso: string
): Promise<CaptureAsset | null> {
  const existing = await getCaptureById(scope, db, captureId);
  if (!existing) {
    return null;
  }

  const updated: CaptureAsset = {
    ...existing,
    llm_consent_at: consentAtIso,
    updated_at: consentAtIso
  };

  const res = await db
    .prepare(
      `UPDATE captures
       SET llm_consent_at = ?,
           capture_json = ?,
           updated_at = ?
       WHERE owner_uid = ? AND capture_id = ?`
    )
    .bind(consentAtIso, JSON.stringify(updated), consentAtIso, scope.uid, captureId)
    .run();

  if ((res.meta?.changes ?? 0) === 0) {
    return null;
  }

  return updated;
}
