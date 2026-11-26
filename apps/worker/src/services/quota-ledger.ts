import type { D1Database } from '@cloudflare/workers-types';
import {
  getNextResetIso,
  getPacificDateString,
  getProviderDailyCap,
  getProviderResetTimezone,
  getProviderWindowDate,
  getUtcDateString,
  QUOTA_BLOCK_GENERATION_RATIO,
  QUOTA_PROVIDER_CONFIGS,
  QUOTA_PROVIDERS,
  QUOTA_WARN_RATIO,
  type QuotaProvider,
  type QuotaResetTimezone
} from '@content-desk/shared';
import { AppError } from '../middleware/error-handler.js';
import {
  getQuotaLedgerRow,
  listQuotaLedgerRowsForWindows,
  reserveQuotaAtomic,
  settleQuotaAndUsageBatch,
  type QuotaSettlementItem
} from '../repositories/quota.repo.js';

export interface QuotaReservation {
  provider: QuotaProvider;
  windowDate: string;
  resetTz: QuotaResetTimezone;
  dailyCap: number;
  reservedAmount: number;
}

export interface ProviderQuotaStatus {
  provider: QuotaProvider;
  window_date: string;
  reset_tz: QuotaResetTimezone;
  reset_at: string;
  daily_cap: number;
  used: number;
  reserved: number;
  remaining: number;
  ratio: number;
  warning: boolean;
  generation_blocked: boolean;
}

export interface D1BudgetCheckResult {
  d1ReadsRatio: number;
  d1WritesRatio: number;
  warnings: string[];
}

function resolveDailyCap(provider: QuotaProvider, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  return getProviderDailyCap(provider);
}

/**
 * D1 보수 상한 점검 (80% 경고 / 95% 신규 생성 차단).
 * - d1_reads: 일 4,000,000 (무료 한도 500만의 80%)
 * - d1_writes: 일 80,000 (무료 한도 10만의 80%)
 */
export async function checkD1BudgetForNewGeneration(
  db: D1Database,
  now = new Date()
): Promise<D1BudgetCheckResult> {
  const utcDate = getUtcDateString(now);
  const [readsRow, writesRow] = await Promise.all([
    getQuotaLedgerRow(db, 'd1_reads', utcDate),
    getQuotaLedgerRow(db, 'd1_writes', utcDate)
  ]);

  const readsCap = readsRow?.daily_cap ?? getProviderDailyCap('d1_reads');
  const writesCap = writesRow?.daily_cap ?? getProviderDailyCap('d1_writes');
  const readsTotal = (readsRow?.used ?? 0) + (readsRow?.reserved ?? 0);
  const writesTotal = (writesRow?.used ?? 0) + (writesRow?.reserved ?? 0);

  const d1ReadsRatio = readsCap > 0 ? readsTotal / readsCap : 1;
  const d1WritesRatio = writesCap > 0 ? writesTotal / writesCap : 1;
  const warnings: string[] = [];

  if (d1ReadsRatio >= QUOTA_BLOCK_GENERATION_RATIO || d1WritesRatio >= QUOTA_BLOCK_GENERATION_RATIO) {
    throw new AppError(
      503,
      'D1_DAILY_LIMIT_EXCEEDED',
      'D1 일일 보수 상한의 95%에 도달하여 신규 생성이 중단되었습니다. 다음 UTC 자정 이후 다시 시도해 주세요.',
      {
        resetAt: getNextResetIso('UTC', now),
        details: {
          d1_reads_ratio: Number(d1ReadsRatio.toFixed(4)),
          d1_writes_ratio: Number(d1WritesRatio.toFixed(4))
        }
      }
    );
  }

  if (d1ReadsRatio >= QUOTA_WARN_RATIO) {
    warnings.push(`D1 일일 읽기 추정치가 보수 상한의 ${Math.round(d1ReadsRatio * 100)}%에 도달했습니다.`);
  }
  if (d1WritesRatio >= QUOTA_WARN_RATIO) {
    warnings.push(`D1 일일 쓰기 추정치가 보수 상한의 ${Math.round(d1WritesRatio * 100)}%에 도달했습니다.`);
  }

  return { d1ReadsRatio, d1WritesRatio, warnings };
}

/**
 * 단계 요청 시작 시 전역 quota_ledger SQL 원자 예약.
 * - 예약 실패 시 429 QUOTA_EXCEEDED를 발생시키며 usage_daily는 절대 변경하지 않습니다.
 * - daily_cap이 0인 제공자(예: gemini_image)는 즉시 예약을 거부합니다.
 */
export async function reserveProviderQuota(
  db: D1Database,
  params: {
    provider: QuotaProvider;
    amount: number;
    now?: Date;
    dailyCapOverride?: number;
    checkD1Budget?: boolean;
  }
): Promise<QuotaReservation> {
  const now = params.now ?? new Date();
  const checkD1 = params.checkD1Budget ?? true;

  if (checkD1 && params.provider !== 'd1_reads' && params.provider !== 'd1_writes') {
    await checkD1BudgetForNewGeneration(db, now);
  }

  const resetTz = getProviderResetTimezone(params.provider);
  const windowDate = getProviderWindowDate(params.provider, now);
  const dailyCap = resolveDailyCap(params.provider, params.dailyCapOverride);
  const amount = Math.max(1, Math.floor(params.amount));

  const reserved = await reserveQuotaAtomic(db, {
    provider: params.provider,
    windowDate,
    resetTz,
    dailyCap,
    amount,
    nowIso: now.toISOString()
  });

  if (!reserved) {
    const resetAt = getNextResetIso(resetTz, now);
    throw new AppError(
      429,
      'QUOTA_EXCEEDED',
      `전체 사용자 공유 일일 할당량(${params.provider})이 소진되었습니다. 다음 초기화 시각(${resetAt}) 이후 다시 시도해 주세요.`,
      {
        resetAt,
        details: {
          provider: params.provider,
          daily_cap: dailyCap,
          reset_tz: resetTz
        }
      }
    );
  }

  return {
    provider: params.provider,
    windowDate,
    resetTz,
    dailyCap,
    reservedAmount: amount
  };
}

/**
 * 단계 종료 정산 batch():
 * - quota_ledger 예약 해제 + 실제 사용량 반영
 * - actualUsed > 0인 외부 제공자에 대해 usage_daily calls 증가 (예약 실패/0 사용 시 불변)
 * - 요청당 인증 users 1 read + 정산 usage_daily 1 write를 포함한 d1_reads/d1_writes 추적
 */
export async function settleProviderQuotas(
  db: D1Database,
  params: {
    ownerUid: string;
    settlements: ReadonlyArray<{
      reservation: QuotaReservation;
      actualUsed: number;
    }>;
    d1Reads?: number;
    d1Writes?: number;
    includeAuthUserRead?: boolean;
    now?: Date;
  }
): Promise<void> {
  const now = params.now ?? new Date();
  const utcDate = getUtcDateString(now);

  const items: QuotaSettlementItem[] = params.settlements.map(({ reservation, actualUsed }) => ({
    provider: reservation.provider,
    windowDate: reservation.windowDate,
    resetTz: reservation.resetTz,
    dailyCap: reservation.dailyCap,
    reservedAmount: reservation.reservedAmount,
    actualUsed: Math.max(0, Math.floor(actualUsed)),
    recordInUsageDaily: reservation.provider !== 'd1_reads' && reservation.provider !== 'd1_writes'
  }));

  const usageDailyWrites = items.filter((i) => i.recordInUsageDaily && i.actualUsed > 0).length;
  const quotaLedgerWrites = items.length;
  const authRead = (params.includeAuthUserRead ?? true) ? 1 : 0;

  // 요청당 인증 users 1 read + 호출부 추정 읽기 + quota_ledger/usage_daily 정산 쓰기
  const d1ReadsDelta = authRead + Math.max(0, Math.floor(params.d1Reads ?? 0));
  const d1WritesDelta =
    usageDailyWrites + quotaLedgerWrites + Math.max(0, Math.floor(params.d1Writes ?? 0));

  await settleQuotaAndUsageBatch(db, {
    ownerUid: params.ownerUid,
    items,
    d1WindowDate: utcDate,
    d1ReadsCap: getProviderDailyCap('d1_reads'),
    d1WritesCap: getProviderDailyCap('d1_writes'),
    d1ReadsDelta,
    d1WritesDelta,
    nowIso: now.toISOString()
  });
}

export async function settleSingleProviderQuota(
  db: D1Database,
  params: {
    ownerUid: string;
    reservation: QuotaReservation;
    actualUsed: number;
    d1Reads?: number;
    d1Writes?: number;
    includeAuthUserRead?: boolean;
    now?: Date;
  }
): Promise<void> {
  await settleProviderQuotas(db, {
    ownerUid: params.ownerUid,
    settlements: [{ reservation: params.reservation, actualUsed: params.actualUsed }],
    d1Reads: params.d1Reads,
    d1Writes: params.d1Writes,
    includeAuthUserRead: params.includeAuthUserRead,
    now: params.now
  });
}

export async function getGlobalQuotaSummary(
  db: D1Database,
  now = new Date()
): Promise<ProviderQuotaStatus[]> {
  const utcDate = getUtcDateString(now);
  const pacificDate = getPacificDateString(now);
  const rows = await listQuotaLedgerRowsForWindows(db, utcDate, pacificDate);
  const rowMap = new Map(rows.map((r) => [`${r.provider}:${r.window_date}`, r]));

  return QUOTA_PROVIDERS.map((provider) => {
    const config = QUOTA_PROVIDER_CONFIGS[provider];
    const windowDate = getProviderWindowDate(provider, now);
    const row = rowMap.get(`${provider}:${windowDate}`);
    const dailyCap = row?.daily_cap ?? config.dailyCap;
    const used = row?.used ?? 0;
    const reserved = row?.reserved ?? 0;
    const remaining = Math.max(0, dailyCap - used - reserved);
    const ratio = dailyCap > 0 ? (used + reserved) / dailyCap : 1;

    return {
      provider,
      window_date: windowDate,
      reset_tz: config.resetTz,
      reset_at: getNextResetIso(config.resetTz, now),
      daily_cap: dailyCap,
      used,
      reserved,
      remaining,
      ratio: Number(ratio.toFixed(4)),
      warning: dailyCap > 0 && ratio >= QUOTA_WARN_RATIO,
      generation_blocked: dailyCap === 0 || ratio >= QUOTA_BLOCK_GENERATION_RATIO
    };
  });
}
