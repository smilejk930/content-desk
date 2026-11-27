import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { CaptureAsset } from '@content-desk/shared';

/**
 * Cron Trigger 전용 전역 리포지토리 (OWNER_UID_LINT_EXCEPTIONS 허용 범위):
 * 1) 활성 사용자(ADMIN_UIDS + users.status='active', blocked 제외) 대상 라운드로빈 순위 추적 조회·기록
 * 2) 30일 경과 usage_daily 행 삭제
 * 3) 미등록 R2 고아 객체(users/*\/captures/*) 판별용 captures 등록 키 및 capture_id 보호 집합 조회
 * 4) app_meta 전역 R2 스캔 커서·용량 캐시·연속 실패 횟수 저장 및 초기 미집계 상태의 D1 총합 폴백 산출
 */

export const APP_META_R2_USAGE_BYTES = 'r2_usage_bytes';
export const APP_META_R2_USAGE_UPDATED_AT = 'r2_usage_updated_at';
export const APP_META_R2_SCAN_CURSOR = 'r2_scan_cursor';
export const APP_META_R2_SCAN_ACCUM_BYTES = 'r2_scan_accum_bytes';
export const APP_META_R2_SCAN_CONSECUTIVE_FAILURES = 'r2_scan_consecutive_failures';

export interface AppMetaRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface GlobalR2UsageEstimate {
  usedBytes: number;
  source: 'r2_scan_cache' | 'd1_fallback';
  updatedAt: string | null;
}

export interface CronTrackingPair {
  owner_uid: string;
  post_id: string;
  log_no: string;
  post_url: string;
  keyword: string;
}

export interface CronTrackingSelection {
  pairs: CronTrackingPair[];
  /** post_id -> { ownerUid, allKeywords, alreadyCheckedKeywords } */
  postMeta: Map<
    string,
    {
      ownerUid: string;
      allKeywords: string[];
      alreadyCheckedKeywords: Set<string>;
    }
  >;
}

export interface RegisteredCaptureLookupResult {
  registeredR2Keys: Set<string>;
  registeredCaptureIds: Set<string>;
  malformedCaptureIds: Set<string>;
}

interface CandidatePostRow {
  post_id: string;
  owner_uid: string;
  log_no: string;
  post_url: string;
  target_keywords_json: string;
  published_at: string;
  last_tracked_date: string | null;
  user_rn: number;
}

export async function getAppMetaMap(
  db: D1Database,
  keys: readonly string[]
): Promise<Map<string, AppMetaRow>> {
  if (keys.length === 0) return new Map();
  const placeholders = keys.map(() => '?').join(', ');
  const res = await db
    .prepare(`SELECT key, value, updated_at FROM app_meta WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<AppMetaRow>();
  return new Map((res.results ?? []).map((row) => [row.key, row]));
}

export async function upsertAppMetaBatch(
  db: D1Database,
  entries: ReadonlyArray<{ key: string; value: string }>,
  nowIso: string
): Promise<void> {
  if (entries.length === 0) return;
  const statements: D1PreparedStatement[] = entries.map((entry) =>
    db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(entry.key, entry.value, nowIso)
  );
  await db.batch(statements);
}

/**
 * 전역 R2 사용량 조회:
 * - app_meta.r2_usage_bytes 캐시가 존재하면 캐시값 사용
 * - 초기 미집계 상태에서는 D1 captures 사진 바이트 + source_snapshots 문자 수 합계로 보수 폴백
 *   (사용자 내용물·개인별 내역은 반환하지 않고 전역 바이트 숫자 합계만 반환)
 */
export async function getGlobalR2UsageEstimate(db: D1Database): Promise<GlobalR2UsageEstimate> {
  const metaMap = await getAppMetaMap(db, [APP_META_R2_USAGE_BYTES, APP_META_R2_USAGE_UPDATED_AT]);
  const cachedRow = metaMap.get(APP_META_R2_USAGE_BYTES);
  if (cachedRow) {
    const parsed = Number.parseInt(cachedRow.value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return {
        usedBytes: parsed,
        source: 'r2_scan_cache',
        updatedAt: metaMap.get(APP_META_R2_USAGE_UPDATED_AT)?.value ?? cachedRow.updated_at
      };
    }
  }

  const [capturesRes, snapshotsRow] = await Promise.all([
    db.prepare('SELECT capture_json FROM captures').all<{ capture_json: string }>(),
    db
      .prepare('SELECT COALESCE(SUM(char_count), 0) AS total_chars FROM source_snapshots')
      .first<{ total_chars: number | null }>()
  ]);

  let captureBytes = 0;
  for (const row of capturesRes.results ?? []) {
    try {
      const parsed = JSON.parse(row.capture_json) as Partial<CaptureAsset>;
      for (const photo of parsed.photos ?? []) {
        if (typeof photo.byte_size === 'number' && Number.isFinite(photo.byte_size) && photo.byte_size > 0) {
          captureBytes += Math.floor(photo.byte_size);
        }
      }
    } catch {
      // ignore malformed json
    }
  }

  const snapshotBytes = Math.max(0, Math.floor(Number(snapshotsRow?.total_chars ?? 0)));

  return {
    usedBytes: captureBytes + snapshotBytes,
    source: 'd1_fallback',
    updatedAt: null
  };
}

function parseTargetKeywords(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return [
        ...new Set(
          parsed
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        )
      ];
    }
  } catch {
    // ignore
  }
  return [];
}

/**
 * 활성 사용자(ADMIN_UIDS + users.status = 'active', blocked 제외)의 추적 대상 발행 글에서
 * 사용자 간 라운드로빈 순서로 최대 maxPairs개 (owner_uid, post_id, keyword) 쌍을 선택합니다.
 * - 후보 글을 LIMIT 50으로 제한해 오늘자 rank_history 조회를 단일 D1 쿼리(바인드 <= 51개)로 유지합니다.
 */
export async function selectRoundRobinRankTrackingPairs(
  db: D1Database,
  params: {
    kstToday: string;
    adminUids: readonly string[];
    maxPairs: number;
  }
): Promise<CronTrackingSelection> {
  const maxPairs = Math.max(1, Math.floor(params.maxPairs));
  const cleanAdmins = [...new Set(params.adminUids.map((u) => u.trim()).filter((u) => u.length > 0))];

  const activeClause =
    cleanAdmins.length > 0
      ? `(p.owner_uid IN (${cleanAdmins.map(() => '?').join(', ')})
          OR EXISTS (SELECT 1 FROM users u WHERE u.uid = p.owner_uid AND u.status = 'active'))`
      : `EXISTS (SELECT 1 FROM users u WHERE u.uid = p.owner_uid AND u.status = 'active')`;

  const candidateRes = await db
    .prepare(
      `WITH active_posts AS (
         SELECT p.post_id, p.owner_uid, p.log_no, p.post_url, p.target_keywords_json,
                p.published_at, p.last_tracked_date,
                ROW_NUMBER() OVER (
                  PARTITION BY p.owner_uid
                  ORDER BY COALESCE(p.last_tracked_date, '0000-00-00') ASC,
                           p.published_at ASC,
                           p.post_id ASC
                ) AS user_rn
         FROM published_posts p
         WHERE p.track_until >= ?
           AND (p.last_tracked_date IS NULL OR p.last_tracked_date < ?)
           AND ${activeClause}
       )
       SELECT post_id, owner_uid, log_no, post_url, target_keywords_json,
              published_at, last_tracked_date, user_rn
       FROM active_posts
       ORDER BY user_rn ASC,
                COALESCE(last_tracked_date, '0000-00-00') ASC,
                published_at ASC,
                post_id ASC
       LIMIT 50`
    )
    .bind(params.kstToday, params.kstToday, ...cleanAdmins)
    .all<CandidatePostRow>();

  const candidates = candidateRes.results ?? [];
  if (candidates.length === 0) {
    return { pairs: [], postMeta: new Map() };
  }

  // 오늘(KST) 이미 조회 완료된 (post_id, keyword) 조회 (최대 50건 -> 단일 D1 쿼리)
  const alreadyCheckedByPost = new Map<string, Set<string>>();
  const postIds = candidates.map((c) => c.post_id);
  const placeholders = postIds.map(() => '?').join(', ');
  const checkedRes = await db
    .prepare(
      `SELECT post_id, keyword
       FROM rank_history
       WHERE checked_date = ?
         AND post_id IN (${placeholders})`
    )
    .bind(params.kstToday, ...postIds)
    .all<{ post_id: string; keyword: string }>();

  for (const row of checkedRes.results ?? []) {
    const set = alreadyCheckedByPost.get(row.post_id) ?? new Set<string>();
    set.add(row.keyword);
    alreadyCheckedByPost.set(row.post_id, set);
  }

  const postMeta = new Map<
    string,
    { ownerUid: string; allKeywords: string[]; alreadyCheckedKeywords: Set<string> }
  >();
  const queuesByOwner = new Map<string, CronTrackingPair[]>();
  const ownerOrder: string[] = [];

  for (const post of candidates) {
    const keywords = parseTargetKeywords(post.target_keywords_json);
    const checkedSet = alreadyCheckedByPost.get(post.post_id) ?? new Set<string>();
    postMeta.set(post.post_id, {
      ownerUid: post.owner_uid,
      allKeywords: keywords,
      alreadyCheckedKeywords: new Set(checkedSet)
    });

    for (const keyword of keywords) {
      if (checkedSet.has(keyword)) continue;
      let queue = queuesByOwner.get(post.owner_uid);
      if (!queue) {
        queue = [];
        queuesByOwner.set(post.owner_uid, queue);
        ownerOrder.push(post.owner_uid);
      }
      queue.push({
        owner_uid: post.owner_uid,
        post_id: post.post_id,
        log_no: post.log_no,
        post_url: post.post_url,
        keyword
      });
    }
  }

  const selected: CronTrackingPair[] = [];
  let madeProgress = true;
  while (selected.length < maxPairs && madeProgress) {
    madeProgress = false;
    for (const ownerUid of ownerOrder) {
      if (selected.length >= maxPairs) break;
      const queue = queuesByOwner.get(ownerUid);
      const next = queue?.shift();
      if (next) {
        selected.push(next);
        madeProgress = true;
      }
    }
  }

  return { pairs: selected, postMeta };
}

/**
 * 순위 추적 결과 및 완료 글 last_tracked_date 일괄 저장 (단일 D1 batch, 최대 20개 문장).
 */
export async function saveRankTrackingBatch(
  db: D1Database,
  params: {
    entries: ReadonlyArray<{
      id: string;
      ownerUid: string;
      postId: string;
      keyword: string;
      rank: number | null;
      checkedDate: string;
      checkedAtIso: string;
    }>;
    completedPosts: ReadonlyArray<{
      ownerUid: string;
      postId: string;
      kstToday: string;
    }>;
  }
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  for (const entry of params.entries) {
    statements.push(
      db
        .prepare(
          `INSERT INTO rank_history (id, owner_uid, post_id, keyword, rank, checked_date, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_uid, post_id, keyword, checked_date)
           DO UPDATE SET rank = excluded.rank, checked_at = excluded.checked_at`
        )
        .bind(
          entry.id,
          entry.ownerUid,
          entry.postId,
          entry.keyword,
          entry.rank,
          entry.checkedDate,
          entry.checkedAtIso
        )
    );
  }

  for (const post of params.completedPosts) {
    statements.push(
      db
        .prepare(
          `UPDATE published_posts
           SET last_tracked_date = ?
           WHERE owner_uid = ? AND post_id = ?`
        )
        .bind(post.kstToday, post.ownerUid, post.postId)
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

export async function deleteUsageDailyBeforeDate(
  db: D1Database,
  cutoffDateYmd: string
): Promise<number> {
  const res = await db
    .prepare('DELETE FROM usage_daily WHERE window_date < ?')
    .bind(cutoffDateYmd)
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * R2 고아 객체 판별용:
 * - 주어진 capture_id 목록(1회 호출당 최대 80개 바인드)에서 D1 captures에 존재하는 capture_id 집합과
 *   정상 파싱된 r2_key 집합, 손상된 capture_json을 가진 capture_id 집합을 함께 반환합니다.
 * - capture_json 파싱에 실패하거나 photos가 비정상이더라도 D1에 capture_id가 존재하는 캡처 아래의
 *   객체는 절대 고아로 삭제되지 않도록 보호합니다.
 */
export async function findRegisteredCaptureR2Keys(
  db: D1Database,
  captureIds: readonly string[]
): Promise<RegisteredCaptureLookupResult> {
  const registeredR2Keys = new Set<string>();
  const registeredCaptureIds = new Set<string>();
  const malformedCaptureIds = new Set<string>();
  const uniqueIds = [...new Set(captureIds.filter((id) => id.length > 0))];
  if (uniqueIds.length === 0) {
    return { registeredR2Keys, registeredCaptureIds, malformedCaptureIds };
  }

  for (let i = 0; i < uniqueIds.length; i += 80) {
    const chunk = uniqueIds.slice(i, i + 80);
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(`SELECT capture_id, capture_json FROM captures WHERE capture_id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ capture_id: string; capture_json: string }>();

    for (const row of res.results ?? []) {
      registeredCaptureIds.add(row.capture_id);
      try {
        const parsed = JSON.parse(row.capture_json) as Partial<CaptureAsset> | null;
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.photos)) {
          malformedCaptureIds.add(row.capture_id);
          continue;
        }
        let hasInvalidPhoto = false;
        for (const photo of parsed.photos) {
          if (photo && typeof photo.r2_key === 'string' && photo.r2_key.length > 0) {
            registeredR2Keys.add(photo.r2_key);
          } else {
            hasInvalidPhoto = true;
          }
        }
        if (hasInvalidPhoto) {
          malformedCaptureIds.add(row.capture_id);
        }
      } catch {
        malformedCaptureIds.add(row.capture_id);
      }
    }
  }

  return { registeredR2Keys, registeredCaptureIds, malformedCaptureIds };
}
