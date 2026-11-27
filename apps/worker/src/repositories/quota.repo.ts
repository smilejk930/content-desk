import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { QuotaProvider, QuotaResetTimezone } from '@content-desk/shared';

/**
 * 전역 할당량 원장(quota_ledger), 관리자용 일일 호출 숫자 집계(usage_daily),
 * 공개 외부 API 캐시(api_cache) 전용 리포지토리.
 * 사용자 내용물 표에는 접근하지 않습니다.
 */

export interface QuotaLedgerRow {
  provider: string;
  window_date: string;
  reset_tz: QuotaResetTimezone;
  daily_cap: number;
  used: number;
  reserved: number;
  updated_at: string;
}

export interface ApiCacheRow {
  cache_key: string;
  payload_json: string;
  expires_at: string;
  backoff_until: string | null;
}

export async function getQuotaLedgerRow(
  db: D1Database,
  provider: QuotaProvider,
  windowDate: string
): Promise<QuotaLedgerRow | null> {
  const row = await db
    .prepare(
      `SELECT provider, window_date, reset_tz, daily_cap, used, reserved, updated_at
       FROM quota_ledger
       WHERE provider = ? AND window_date = ?`
    )
    .bind(provider, windowDate)
    .first<QuotaLedgerRow>();
  return row ?? null;
}

export async function listQuotaLedgerRowsForWindows(
  db: D1Database,
  utcDate: string,
  pacificDate: string
): Promise<QuotaLedgerRow[]> {
  const result = await db
    .prepare(
      `SELECT provider, window_date, reset_tz, daily_cap, used, reserved, updated_at
       FROM quota_ledger
       WHERE window_date IN (?, ?)`
    )
    .bind(utcDate, pacificDate)
    .all<QuotaLedgerRow>();
  return result.results ?? [];
}

/**
 * SQL 원자 예약 차감:
 * 행이 없으면 먼저 생성(INSERT OR IGNORE)하고,
 * (used + reserved + amount) <= daily_cap 조건이 참일 때만 reserved를 증가시킵니다.
 * 예약 실패 시 usage_daily는 전혀 변경되지 않습니다.
 */
export async function reserveQuotaAtomic(
  db: D1Database,
  params: {
    provider: QuotaProvider;
    windowDate: string;
    resetTz: QuotaResetTimezone;
    dailyCap: number;
    amount: number;
    nowIso: string;
  }
): Promise<boolean> {
  if (params.amount <= 0 || params.dailyCap <= 0) {
    return false;
  }

  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO quota_ledger (
           provider, window_date, reset_tz, daily_cap, used, reserved, updated_at
         )
         VALUES (?, ?, ?, ?, 0, 0, ?)`
      )
      .bind(params.provider, params.windowDate, params.resetTz, params.dailyCap, params.nowIso),
    db
      .prepare(
        `UPDATE quota_ledger
         SET reserved = reserved + ?,
             updated_at = ?
         WHERE provider = ?
           AND window_date = ?
           AND (used + reserved + ?) <= daily_cap`
      )
      .bind(params.amount, params.nowIso, params.provider, params.windowDate, params.amount)
  ]);

  const updateMeta = results[1]?.meta;
  return (updateMeta?.changes ?? 0) === 1;
}

export interface QuotaSettlementItem {
  provider: QuotaProvider;
  windowDate: string;
  resetTz: QuotaResetTimezone;
  dailyCap: number;
  reservedAmount: number;
  actualUsed: number;
  recordInUsageDaily: boolean;
}

/**
 * 단계 종료 정산 batch():
 * 1) quota_ledger의 reserved를 해제하고 실제 사용량(actualUsed)을 used에 반영
 * 2) actualUsed > 0인 외부 API/LLM 제공자는 요청자 owner_uid의 usage_daily calls를 증가
 * 3) 같은 batch() 안에서 추정 d1_reads / d1_writes (요청당 인증 users 1 read, 정산 usage_daily 1 write 포함) 기록
 */
export async function settleQuotaAndUsageBatch(
  db: D1Database,
  params: {
    ownerUid: string | null;
    items: readonly QuotaSettlementItem[];
    d1WindowDate: string;
    d1ReadsCap: number;
    d1WritesCap: number;
    d1ReadsDelta: number;
    d1WritesDelta: number;
    nowIso: string;
  }
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  for (const item of params.items) {
    const safeUsed = Math.max(0, Math.floor(item.actualUsed));
    const safeReserved = Math.max(0, Math.floor(item.reservedAmount));

    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO quota_ledger (
             provider, window_date, reset_tz, daily_cap, used, reserved, updated_at
           )
           VALUES (?, ?, ?, ?, 0, 0, ?)`
        )
        .bind(item.provider, item.windowDate, item.resetTz, item.dailyCap, params.nowIso)
    );

    statements.push(
      db
        .prepare(
          `UPDATE quota_ledger
           SET used = used + ?,
               reserved = MAX(0, reserved - ?),
               updated_at = ?
           WHERE provider = ? AND window_date = ?`
        )
        .bind(safeUsed, safeReserved, params.nowIso, item.provider, item.windowDate)
    );

    if (item.recordInUsageDaily && safeUsed > 0 && params.ownerUid) {
      statements.push(
        db
          .prepare(
            `INSERT INTO usage_daily (owner_uid, provider, window_date, calls)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(owner_uid, provider, window_date)
             DO UPDATE SET calls = calls + excluded.calls`
          )
          .bind(params.ownerUid, item.provider, item.windowDate, safeUsed)
      );
    }
  }

  if (params.d1ReadsDelta > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO quota_ledger (
             provider, window_date, reset_tz, daily_cap, used, reserved, updated_at
           )
           VALUES ('d1_reads', ?, 'UTC', ?, ?, 0, ?)
           ON CONFLICT(provider, window_date)
           DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at`
        )
        .bind(params.d1WindowDate, params.d1ReadsCap, params.d1ReadsDelta, params.nowIso)
    );
  }

  if (params.d1WritesDelta > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO quota_ledger (
             provider, window_date, reset_tz, daily_cap, used, reserved, updated_at
           )
           VALUES ('d1_writes', ?, 'UTC', ?, ?, 0, ?)
           ON CONFLICT(provider, window_date)
           DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at`
        )
        .bind(params.d1WindowDate, params.d1WritesCap, params.d1WritesDelta, params.nowIso)
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

export async function getApiCacheEntry(
  db: D1Database,
  cacheKey: string
): Promise<ApiCacheRow | null> {
  const row = await db
    .prepare(
      `SELECT cache_key, payload_json, expires_at, backoff_until
       FROM api_cache
       WHERE cache_key = ?`
    )
    .bind(cacheKey)
    .first<ApiCacheRow>();
  return row ?? null;
}

export async function upsertApiCacheEntry(
  db: D1Database,
  params: {
    cacheKey: string;
    payloadJson: string;
    expiresAtIso: string;
    backoffUntilIso?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_cache (cache_key, payload_json, expires_at, backoff_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cache_key)
       DO UPDATE SET payload_json = excluded.payload_json,
                     expires_at = excluded.expires_at,
                     backoff_until = excluded.backoff_until`
    )
    .bind(
      params.cacheKey,
      params.payloadJson,
      params.expiresAtIso,
      params.backoffUntilIso ?? null
    )
    .run();
}
