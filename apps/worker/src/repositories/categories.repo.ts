import type { D1Database } from '@cloudflare/workers-types';
import type { CategoryProfile } from '@content-desk/shared';
import type { UserScope } from '../env.js';

interface CategoryDbRow {
  category_id: string;
  owner_uid: string;
  display_name: string;
  discovery_mode: CategoryProfile['discovery_mode'];
  datalab_anchor_keyword: string | null;
  default_visibility: CategoryProfile['default_visibility'];
  profile_json: string;
  created_at: string;
  updated_at: string;
}

function hydrateCategoryRow(row: CategoryDbRow): CategoryProfile {
  const parsed = JSON.parse(row.profile_json) as Partial<CategoryProfile>;
  return {
    category_id: row.category_id,
    display_name: row.display_name,
    naver_board_name: parsed.naver_board_name ?? row.display_name,
    discovery_mode: row.discovery_mode,
    datalab_anchor_keyword: row.datalab_anchor_keyword,
    seed_keywords: parsed.seed_keywords ?? [],
    primary_source_domains: parsed.primary_source_domains ?? [],
    default_media_policy: parsed.default_media_policy ?? {
      allowed_content_types:
        row.discovery_mode === 'none'
          ? ['vlog']
          : row.discovery_mode === 'experience_first'
            ? ['experience_review']
            : ['explainer'],
      min_real_photos: 0,
      require_field_memo: false
    },
    default_visibility: row.default_visibility,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function listCategories(
  scope: UserScope,
  db: D1Database
): Promise<CategoryProfile[]> {
  const result = await db
    .prepare(
      `SELECT category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword,
              default_visibility, profile_json, created_at, updated_at
       FROM categories
       WHERE owner_uid = ?
       ORDER BY created_at DESC`
    )
    .bind(scope.uid)
    .all<CategoryDbRow>();

  return (result.results ?? []).map(hydrateCategoryRow);
}

export async function getCategoryById(
  scope: UserScope,
  db: D1Database,
  categoryId: string
): Promise<CategoryProfile | null> {
  const row = await db
    .prepare(
      `SELECT category_id, owner_uid, display_name, discovery_mode, datalab_anchor_keyword,
              default_visibility, profile_json, created_at, updated_at
       FROM categories
       WHERE owner_uid = ? AND category_id = ?`
    )
    .bind(scope.uid, categoryId)
    .first<CategoryDbRow>();

  return row ? hydrateCategoryRow(row) : null;
}

export async function createCategory(
  scope: UserScope,
  db: D1Database,
  profile: CategoryProfile
): Promise<CategoryProfile> {
  await db
    .prepare(
      `INSERT INTO categories (
         category_id, owner_uid, display_name, discovery_mode,
         datalab_anchor_keyword, default_visibility, profile_json,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      profile.category_id,
      scope.uid,
      profile.display_name,
      profile.discovery_mode,
      profile.datalab_anchor_keyword,
      profile.default_visibility,
      JSON.stringify(profile),
      profile.created_at,
      profile.updated_at
    )
    .run();

  return profile;
}

export async function updateCategory(
  scope: UserScope,
  db: D1Database,
  profile: CategoryProfile
): Promise<CategoryProfile | null> {
  const res = await db
    .prepare(
      `UPDATE categories
       SET display_name = ?,
           discovery_mode = ?,
           datalab_anchor_keyword = ?,
           default_visibility = ?,
           profile_json = ?,
           updated_at = ?
       WHERE owner_uid = ? AND category_id = ?`
    )
    .bind(
      profile.display_name,
      profile.discovery_mode,
      profile.datalab_anchor_keyword,
      profile.default_visibility,
      JSON.stringify(profile),
      profile.updated_at,
      scope.uid,
      profile.category_id
    )
    .run();

  if ((res.meta?.changes ?? 0) === 0) {
    return null;
  }
  return profile;
}

export async function deleteCategory(
  scope: UserScope,
  db: D1Database,
  categoryId: string
): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM categories WHERE owner_uid = ? AND category_id = ?')
    .bind(scope.uid, categoryId)
    .run();

  return (res.meta?.changes ?? 0) > 0;
}
