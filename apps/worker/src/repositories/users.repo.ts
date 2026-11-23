import type { D1Database } from '@cloudflare/workers-types';
import type {
  AdminUserItem,
  AdminUsersListResponse,
  AdminUserTodayUsage,
  UserStatus
} from '@content-desk/shared';

/**
 * usage_daily.window_date 기준 통일:
 * - quota_ledger의 제공자별 기준 시간대(gemini* 계열은 America/Los_Angeles 날짜, 그 외 제공자는 UTC 날짜, YYYY-MM-DD)로
 *   기록·조회하며 Phase 3 quota-ledger.ts 정산 batch()도 동일 기준을 따릅니다.
 * - 이 리포지토리는 users와 usage_daily만 다루며 사용자 내용물 표에는 접근하지 않습니다.
 */

interface UserRow {
  uid: string;
  label: string;
  status: UserStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  status_changed_at: string;
}

interface UsageDailyRow {
  owner_uid: string;
  provider: string;
  calls: number;
}

export interface UsageWindowDates {
  utcDate: string;
  pacificDate: string;
}

const PACIFIC_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
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

export function getUsageWindowDates(now = new Date()): UsageWindowDates {
  return {
    utcDate: getUtcDateString(now),
    pacificDate: getPacificDateString(now)
  };
}

function emptyUsage(windowDate: string): AdminUserTodayUsage {
  return {
    date: windowDate,
    totalCalls: 0,
    byProvider: {}
  };
}

function toAdminUserItem(row: UserRow, usage: AdminUserTodayUsage): AdminUserItem {
  return {
    uid: row.uid,
    label: row.label,
    status: row.status,
    role: 'user',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at,
    todayUsage: usage
  };
}

async function getUsageMapForWindows(
  db: D1Database,
  windows: UsageWindowDates
): Promise<Map<string, AdminUserTodayUsage>> {
  const usageResult = await db
    .prepare(
      `SELECT owner_uid, provider, calls
       FROM usage_daily
       WHERE (provider LIKE 'gemini%' AND window_date = ?)
          OR (provider NOT LIKE 'gemini%' AND window_date = ?)`
    )
    .bind(windows.pacificDate, windows.utcDate)
    .all<UsageDailyRow>();

  const map = new Map<string, AdminUserTodayUsage>();
  for (const row of usageResult.results ?? []) {
    const existing = map.get(row.owner_uid) ?? emptyUsage(windows.utcDate);
    existing.byProvider[row.provider] = (existing.byProvider[row.provider] ?? 0) + row.calls;
    existing.totalCalls += row.calls;
    map.set(row.owner_uid, existing);
  }
  return map;
}

async function getUsageForUserInWindows(
  db: D1Database,
  ownerUid: string,
  windows: UsageWindowDates
): Promise<AdminUserTodayUsage> {
  const result = await db
    .prepare(
      `SELECT provider, calls
       FROM usage_daily
       WHERE owner_uid = ?
         AND (
           (provider LIKE 'gemini%' AND window_date = ?)
           OR (provider NOT LIKE 'gemini%' AND window_date = ?)
         )`
    )
    .bind(ownerUid, windows.pacificDate, windows.utcDate)
    .all<{ provider: string; calls: number }>();

  const usage = emptyUsage(windows.utcDate);
  for (const row of result.results ?? []) {
    usage.byProvider[row.provider] = (usage.byProvider[row.provider] ?? 0) + row.calls;
    usage.totalCalls += row.calls;
  }
  return usage;
}

export async function findUserByUid(db: D1Database, uid: string): Promise<UserRow | null> {
  const row = await db
    .prepare(
      'SELECT uid, label, status, created_by, created_at, updated_at, status_changed_at FROM users WHERE uid = ?'
    )
    .bind(uid)
    .first<UserRow>();
  return row ?? null;
}

export async function listUsersWithTodayUsage(
  db: D1Database,
  adminUids: string[],
  windows: UsageWindowDates
): Promise<AdminUsersListResponse> {
  const [usersResult, usageMap] = await Promise.all([
    db
      .prepare(
        'SELECT uid, label, status, created_by, created_at, updated_at, status_changed_at FROM users ORDER BY created_at DESC'
      )
      .all<UserRow>(),
    getUsageMapForWindows(db, windows)
  ]);

  const seenUids = new Set<string>();
  const items: AdminUserItem[] = [];

  for (const rawUid of adminUids) {
    const uid = rawUid.trim();
    if (!uid || seenUids.has(uid)) continue;
    seenUids.add(uid);
    items.push({
      uid,
      label: '관리자 (ADMIN_UIDS)',
      status: 'active',
      role: 'admin',
      createdAt: null,
      updatedAt: null,
      statusChangedAt: null,
      todayUsage: usageMap.get(uid) ?? emptyUsage(windows.utcDate)
    });
  }

  for (const row of usersResult.results ?? []) {
    if (seenUids.has(row.uid)) continue;
    seenUids.add(row.uid);
    items.push(toAdminUserItem(row, usageMap.get(row.uid) ?? emptyUsage(windows.utcDate)));
  }

  return {
    windowDate: windows.utcDate,
    users: items
  };
}

export async function createUser(
  db: D1Database,
  params: {
    uid: string;
    label: string;
    createdBy: string;
    nowIso: string;
    windows: UsageWindowDates;
  }
): Promise<AdminUserItem> {
  await db
    .prepare(
      `INSERT INTO users (uid, label, status, created_by, created_at, updated_at, status_changed_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`
    )
    .bind(
      params.uid,
      params.label,
      params.createdBy,
      params.nowIso,
      params.nowIso,
      params.nowIso
    )
    .run();

  const usage = await getUsageForUserInWindows(db, params.uid, params.windows);
  return {
    uid: params.uid,
    label: params.label,
    status: 'active',
    role: 'user',
    createdAt: params.nowIso,
    updatedAt: params.nowIso,
    statusChangedAt: params.nowIso,
    todayUsage: usage
  };
}

export async function updateUser(
  db: D1Database,
  params: {
    uid: string;
    label?: string;
    status?: UserStatus;
    nowIso: string;
    windows: UsageWindowDates;
  }
): Promise<AdminUserItem | null> {
  const existing = await findUserByUid(db, params.uid);
  if (!existing) return null;

  const nextLabel = params.label ?? existing.label;
  const nextStatus = params.status ?? existing.status;
  const nextStatusChangedAt =
    params.status !== undefined && params.status !== existing.status
      ? params.nowIso
      : existing.status_changed_at;

  await db
    .prepare(
      `UPDATE users
       SET label = ?, status = ?, updated_at = ?, status_changed_at = ?
       WHERE uid = ?`
    )
    .bind(nextLabel, nextStatus, params.nowIso, nextStatusChangedAt, params.uid)
    .run();

  const usage = await getUsageForUserInWindows(db, params.uid, params.windows);
  return toAdminUserItem(
    {
      ...existing,
      label: nextLabel,
      status: nextStatus,
      updated_at: params.nowIso,
      status_changed_at: nextStatusChangedAt
    },
    usage
  );
}
