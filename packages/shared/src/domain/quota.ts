export const QUOTA_PROVIDERS = [
  'naver_search',
  'naver_datalab',
  'naver_searchad',
  'gemini_text',
  'gemini_image',
  'd1_reads',
  'd1_writes'
] as const;

export type QuotaProvider = (typeof QUOTA_PROVIDERS)[number];
export type QuotaResetTimezone = 'UTC' | 'America/Los_Angeles';

export interface QuotaProviderConfig {
  readonly provider: QuotaProvider;
  readonly resetTz: QuotaResetTimezone;
  readonly dailyCap: number;
}

/**
 * 오너 확정 일일 할당량 보수 기본값 및 제공자별 초기화 시간대 단일 원천 표.
 * - users.repo.ts와 quota-ledger.ts가 모두 이 매핑 표를 공유합니다.
 * - gemini_image는 0원 무료 티어 운영 원칙에 따라 기본 상한 0으로 설정합니다.
 */
export const QUOTA_PROVIDER_CONFIGS: Readonly<Record<QuotaProvider, QuotaProviderConfig>> = {
  naver_search: {
    provider: 'naver_search',
    resetTz: 'UTC',
    dailyCap: 25_000
  },
  naver_datalab: {
    provider: 'naver_datalab',
    resetTz: 'UTC',
    dailyCap: 1_000
  },
  naver_searchad: {
    provider: 'naver_searchad',
    resetTz: 'UTC',
    dailyCap: 1_000
  },
  gemini_text: {
    provider: 'gemini_text',
    resetTz: 'America/Los_Angeles',
    dailyCap: 250
  },
  gemini_image: {
    provider: 'gemini_image',
    resetTz: 'America/Los_Angeles',
    dailyCap: 0
  },
  d1_reads: {
    provider: 'd1_reads',
    resetTz: 'UTC',
    dailyCap: 4_000_000
  },
  d1_writes: {
    provider: 'd1_writes',
    resetTz: 'UTC',
    dailyCap: 80_000
  }
};

export const GEMINI_TEXT_MODEL = 'gemini-2.5-flash';
export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_BLOCK_GENERATION_RATIO = 0.95;

export const PACIFIC_QUOTA_PROVIDERS: readonly QuotaProvider[] = QUOTA_PROVIDERS.filter(
  (provider) => QUOTA_PROVIDER_CONFIGS[provider].resetTz === 'America/Los_Angeles'
);

export const UTC_QUOTA_PROVIDERS: readonly QuotaProvider[] = QUOTA_PROVIDERS.filter(
  (provider) => QUOTA_PROVIDER_CONFIGS[provider].resetTz === 'UTC'
);

export function isQuotaProvider(value: string): value is QuotaProvider {
  return Object.prototype.hasOwnProperty.call(QUOTA_PROVIDER_CONFIGS, value);
}

export function getProviderResetTimezone(provider: string): QuotaResetTimezone {
  if (isQuotaProvider(provider)) {
    return QUOTA_PROVIDER_CONFIGS[provider].resetTz;
  }
  return 'UTC';
}

export function getProviderDailyCap(provider: QuotaProvider): number {
  return QUOTA_PROVIDER_CONFIGS[provider].dailyCap;
}

const PACIFIC_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const PACIFIC_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

export function getUtcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function getPacificDateString(now = new Date()): string {
  const parts = PACIFIC_DATE_FORMATTER.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

export function getProviderWindowDate(provider: string, now = new Date()): string {
  const tz = getProviderResetTimezone(provider);
  return tz === 'America/Los_Angeles' ? getPacificDateString(now) : getUtcDateString(now);
}

function getPacificOffsetMinutesAt(utcDate: Date): number {
  const parts = PACIFIC_OFFSET_FORMATTER.formatToParts(utcDate);
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? '1970');
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? '1');
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? '1');
  const rawHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const second = Number(parts.find((p) => p.type === 'second')?.value ?? '0');

  const pacificAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((pacificAsUtcMs - utcDate.getTime()) / 60_000);
}

export function getNextResetIso(resetTz: QuotaResetTimezone, now = new Date()): string {
  if (resetTz === 'UTC') {
    const nextUtcMidnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0
    );
    return new Date(nextUtcMidnight).toISOString();
  }

  // Next midnight in America/Los_Angeles (handles PST -08:00 and PDT -07:00)
  const pacificDate = getPacificDateString(now);
  const [yStr, mStr, dStr] = pacificDate.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);

  // Start with an initial UTC guess for next local midnight (assuming -08:00 -> 08:00Z)
  let candidateMs = Date.UTC(y, m - 1, d + 1, 8, 0, 0, 0);
  const offsetMin = getPacificOffsetMinutesAt(new Date(candidateMs));
  // Local midnight = UTC - offsetMin -> UTC = local_midnight_as_utc - offsetMin
  candidateMs = Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0) - offsetMin * 60_000;
  // Re-evaluate once in case DST boundary falls on that exact midnight
  const refinedOffsetMin = getPacificOffsetMinutesAt(new Date(candidateMs));
  candidateMs = Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0) - refinedOffsetMin * 60_000;

  return new Date(candidateMs).toISOString();
}
