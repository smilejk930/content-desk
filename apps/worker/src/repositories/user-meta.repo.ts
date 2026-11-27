import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { UserScope } from '../env.js';

export interface UserMetaRow {
  owner_uid: string;
  key: string;
  value: string;
  updated_at: string;
}

export function prepareUpsertUserMeta(
  scope: UserScope,
  db: D1Database,
  key: string,
  value: string,
  nowIso: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO user_meta (owner_uid, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_uid, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .bind(scope.uid, key, value, nowIso);
}

export async function getUserMeta(
  scope: UserScope,
  db: D1Database,
  key: string
): Promise<UserMetaRow | null> {
  const row = await db
    .prepare('SELECT owner_uid, key, value, updated_at FROM user_meta WHERE owner_uid = ? AND key = ?')
    .bind(scope.uid, key)
    .first<UserMetaRow>();
  return row ?? null;
}

export async function upsertUserMeta(
  scope: UserScope,
  db: D1Database,
  key: string,
  value: string,
  nowIso: string
): Promise<void> {
  await prepareUpsertUserMeta(scope, db, key, value, nowIso).run();
}

export async function listUserMeta(scope: UserScope, db: D1Database): Promise<UserMetaRow[]> {
  const result = await db
    .prepare('SELECT owner_uid, key, value, updated_at FROM user_meta WHERE owner_uid = ? ORDER BY key ASC')
    .bind(scope.uid)
    .all<UserMetaRow>();
  return result.results ?? [];
}

export async function deleteUserMeta(
  scope: UserScope,
  db: D1Database,
  key: string
): Promise<void> {
  await db
    .prepare('DELETE FROM user_meta WHERE owner_uid = ? AND key = ?')
    .bind(scope.uid, key)
    .run();
}
