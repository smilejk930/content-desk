import {
  addDaysToYmd,
  extractNaverBlogId,
  extractNaverLogNo,
  getKstDateString,
  getPacificDateString,
  getProviderDailyCap,
  getUtcDateString
} from '@content-desk/shared';
import { parseCsvList, type WorkerBindings } from '../env.js';
import {
  APP_META_R2_SCAN_ACCUM_BYTES,
  APP_META_R2_SCAN_CONSECUTIVE_FAILURES,
  APP_META_R2_SCAN_CURSOR,
  APP_META_R2_USAGE_BYTES,
  APP_META_R2_USAGE_UPDATED_AT,
  deleteUsageDailyBeforeDate,
  findRegisteredCaptureR2Keys,
  getAppMetaMap,
  saveRankTrackingBatch,
  selectRoundRobinRankTrackingPairs,
  upsertAppMetaBatch
} from '../repositories/cron.repo.js';
import { getQuotaLedgerRow } from '../repositories/quota.repo.js';
import { reserveProviderQuota, settleSingleProviderQuota } from '../services/quota-ledger.js';

const NAVER_BLOG_SEARCH_URL = 'https://openapi.naver.com/v1/search/blog.json';
export const CRON_MAX_RANK_PAIRS_PER_RUN = 10;
export const CRON_R2_LIST_LIMIT = 500;
export const CRON_MAX_ORPHAN_DELETES_PER_RUN = 20;
const CRON_CAPTURE_LOOKUP_BATCH_SIZE = 80;
const CRON_MAX_CAPTURE_LOOKUP_QUERIES = 5;
const ORPHAN_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const USAGE_DAILY_RETENTION_DAYS = 30;
const CAPTURE_KEY_RE = /^users\/([^/]+)\/captures\/([^/]+)\/.+$/;

export interface RankTrackingTaskResult {
  status: 'ok' | 'partial_error' | 'skipped_no_creds' | 'skipped_quota' | 'error';
  kstToday: string;
  checkedPairs: number;
  completedPosts: number;
  nonOkResponses: number;
  errors: string[];
}

export interface UsageCleanupTaskResult {
  status: 'ok' | 'error';
  cutoffDate: string;
  deletedRows: number;
  error?: string;
}

export interface R2MaintenanceTaskResult {
  status: 'ok' | 'error';
  listedCount: number;
  orphanDeletedCount: number;
  scanCompletedCycle: boolean;
  cachedUsageBytes: number | null;
  consecutiveFailures: number;
  cursorReset: boolean;
  error?: string;
}

export interface ScheduledRunResult {
  ranAt: string;
  rankTracking: RankTrackingTaskResult;
  usageCleanup: UsageCleanupTaskResult;
  r2Maintenance: R2MaintenanceTaskResult;
  errors: string[];
}

export class ScheduledRunError extends Error {
  readonly result: ScheduledRunResult;

  constructor(result: ScheduledRunResult) {
    super(
      `Scheduled cron completed with ${result.errors.length} error(s): ${result.errors.join(' | ')}`
    );
    this.name = 'ScheduledRunError';
    this.result = result;
  }
}

/**
 * 네이버 블로그 검색 응답 items(최대 100건)에서 대상 logNo의 1-based 순위를 찾습니다.
 * - URL 경로 끝 숫자 세그먼트와 logNo= 쿼리 파라미터 모두 매칭합니다.
 * - targetPostUrl과 검색 응답 item(link / bloggerlink) 양쪽에서 블로그 ID가 추출되면
 *   블로그 ID까지 일치할 때만 매칭으로 인정해 동명 logNo 오매칭을 차단합니다.
 * - 100위 밖이면 null을 반환합니다.
 */
export function findLogNoRankInBlogItems(
  items: ReadonlyArray<{ link?: string; bloggerlink?: string }>,
  targetLogNo: string,
  targetPostUrl?: string
): number | null {
  const normalizedTarget = targetLogNo.trim();
  if (!normalizedTarget) return null;

  const targetBlogId = targetPostUrl ? extractNaverBlogId(targetPostUrl) : null;
  const limit = Math.min(items.length, 100);

  for (let idx = 0; idx < limit; idx += 1) {
    const item = items[idx];
    const link = item?.link;
    if (!link) continue;

    const extractedLogNo = extractNaverLogNo(link);
    if (extractedLogNo !== normalizedTarget) {
      continue;
    }

    if (targetBlogId) {
      const itemBlogId =
        extractNaverBlogId(link) ??
        (item?.bloggerlink ? extractNaverBlogId(item.bloggerlink) : null);
      if (itemBlogId && itemBlogId !== targetBlogId) {
        continue;
      }
    }

    return idx + 1;
  }
  return null;
}

async function runRankTrackingTask(
  env: WorkerBindings,
  now: Date
): Promise<RankTrackingTaskResult> {
  const kstToday = getKstDateString(now);
  const clientId = env.NAVER_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.NAVER_CLIENT_SECRET?.trim() ?? '';

  if (!clientId || !clientSecret) {
    return {
      status: 'skipped_no_creds',
      kstToday,
      checkedPairs: 0,
      completedPosts: 0,
      nonOkResponses: 0,
      errors: []
    };
  }

  const adminUids = parseCsvList(env.ADMIN_UIDS);
  const selection = await selectRoundRobinRankTrackingPairs(env.DB, {
    kstToday,
    adminUids,
    maxPairs: CRON_MAX_RANK_PAIRS_PER_RUN
  });

  if (selection.pairs.length === 0) {
    return {
      status: 'ok',
      kstToday,
      checkedPairs: 0,
      completedPosts: 0,
      nonOkResponses: 0,
      errors: []
    };
  }

  // 남은 전역 naver_search 할당량 확인 후 가능한 건수만큼만 예약
  const utcDate = getUtcDateString(now);
  const existingQuota = await getQuotaLedgerRow(env.DB, 'naver_search', utcDate);
  const dailyCap = existingQuota?.daily_cap ?? getProviderDailyCap('naver_search');
  const currentUsed = (existingQuota?.used ?? 0) + (existingQuota?.reserved ?? 0);
  const available = Math.max(0, dailyCap - currentUsed);

  if (available <= 0) {
    return {
      status: 'skipped_quota',
      kstToday,
      checkedPairs: 0,
      completedPosts: 0,
      nonOkResponses: 0,
      errors: []
    };
  }

  const pairsToProcess = selection.pairs.slice(0, Math.min(selection.pairs.length, available));

  let reservation;
  try {
    reservation = await reserveProviderQuota(env.DB, {
      provider: 'naver_search',
      amount: pairsToProcess.length,
      now
    });
  } catch {
    return {
      status: 'skipped_quota',
      kstToday,
      checkedPairs: 0,
      completedPosts: 0,
      nonOkResponses: 0,
      errors: []
    };
  }

  const checkedAtIso = now.toISOString();
  const entriesToSave: Array<{
    id: string;
    ownerUid: string;
    postId: string;
    keyword: string;
    rank: number | null;
    checkedDate: string;
    checkedAtIso: string;
  }> = [];
  const errors: string[] = [];
  let nonOkResponses = 0;
  let actualUsed = 0;

  try {
    for (const pair of pairsToProcess) {
      try {
        const url = new URL(NAVER_BLOG_SEARCH_URL);
        url.searchParams.set('query', pair.keyword);
        url.searchParams.set('display', '100');

        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret
          }
        });

        if (!res.ok) {
          nonOkResponses += 1;
          errors.push(`rankTracking: Naver blog.json HTTP ${res.status} (post=${pair.post_id}, kw=${pair.keyword})`);
          continue;
        }

        actualUsed += 1;
        const json = (await res.json()) as {
          items?: Array<{ link?: string; bloggerlink?: string }>;
        };
        const rank = findLogNoRankInBlogItems(json.items ?? [], pair.log_no, pair.post_url);
        entriesToSave.push({
          id: crypto.randomUUID(),
          ownerUid: pair.owner_uid,
          postId: pair.post_id,
          keyword: pair.keyword,
          rank,
          checkedDate: kstToday,
          checkedAtIso
        });

        selection.postMeta.get(pair.post_id)?.alreadyCheckedKeywords.add(pair.keyword);
      } catch (err) {
        errors.push(
          `rankTracking: fetch failed (post=${pair.post_id}, kw=${pair.keyword}): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    const completedPosts: Array<{ ownerUid: string; postId: string; kstToday: string }> = [];
    const touchedPostIds = new Set(entriesToSave.map((e) => e.postId));
    for (const postId of touchedPostIds) {
      const meta = selection.postMeta.get(postId);
      if (!meta) continue;
      const allDone = meta.allKeywords.every((kw) => meta.alreadyCheckedKeywords.has(kw));
      if (allDone) {
        completedPosts.push({
          ownerUid: meta.ownerUid,
          postId,
          kstToday
        });
      }
    }

    await saveRankTrackingBatch(env.DB, {
      entries: entriesToSave,
      completedPosts
    });

    return {
      status: errors.length > 0 ? 'partial_error' : 'ok',
      kstToday,
      checkedPairs: entriesToSave.length,
      completedPosts: completedPosts.length,
      nonOkResponses,
      errors
    };
  } finally {
    // 오너 확정 결정 #2: 크론 백그라운드 naver_search 호출은 전역 quota_ledger만 정산하고
    // 개인 usage_daily에는 귀속하지 않습니다 (D1 read/write 원장은 정산 반영).
    await settleSingleProviderQuota(env.DB, {
      ownerUid: null,
      reservation,
      actualUsed,
      d1Reads: pairsToProcess.length + 2,
      d1Writes: entriesToSave.length + 1,
      includeAuthUserRead: false,
      recordInUsageDaily: false,
      now
    });
  }
}

async function runUsageDailyCleanupTask(
  env: WorkerBindings,
  now: Date
): Promise<UsageCleanupTaskResult> {
  // Pacific 날짜 기준 -30일을 컷오프로 사용해 UTC·Pacific 양쪽 제공자 모두 30일 이상 지난 행만 삭제
  const cutoffDate = addDaysToYmd(getPacificDateString(now), -USAGE_DAILY_RETENTION_DAYS);
  const deletedRows = await deleteUsageDailyBeforeDate(env.DB, cutoffDate);
  return {
    status: 'ok',
    cutoffDate,
    deletedRows
  };
}

async function runR2MaintenanceTask(
  env: WorkerBindings,
  now: Date
): Promise<R2MaintenanceTaskResult> {
  const nowIso = now.toISOString();
  const metaMap = await getAppMetaMap(env.DB, [
    APP_META_R2_SCAN_CURSOR,
    APP_META_R2_SCAN_ACCUM_BYTES,
    APP_META_R2_SCAN_CONSECUTIVE_FAILURES
  ]);

  const savedCursor = metaMap.get(APP_META_R2_SCAN_CURSOR)?.value?.trim() || undefined;
  const savedAccumRaw = metaMap.get(APP_META_R2_SCAN_ACCUM_BYTES)?.value ?? '0';
  const parsedAccum = Number.parseInt(savedAccumRaw, 10);
  let accumBytes = Number.isFinite(parsedAccum) && parsedAccum >= 0 ? parsedAccum : 0;

  const prevFailuresRaw = metaMap.get(APP_META_R2_SCAN_CONSECUTIVE_FAILURES)?.value ?? '0';
  const prevFailures = Number.parseInt(prevFailuresRaw, 10);
  const safePrevFailures = Number.isFinite(prevFailures) && prevFailures >= 0 ? prevFailures : 0;

  try {
    // 크론 1회당 MEDIA_BUCKET.list 1회만 호출 (prefix: 'users/', limit: 500)
    const listed = await env.MEDIA_BUCKET.list({
      prefix: 'users/',
      limit: CRON_R2_LIST_LIMIT,
      cursor: savedCursor
    });

    const orphanGraceCutoffMs = now.getTime() - ORPHAN_GRACE_PERIOD_MS;
    const captureCandidates: Array<{ key: string; captureId: string; size: number }> = [];

    for (const obj of listed.objects) {
      accumBytes += Math.max(0, Math.floor(obj.size));

      // users/*/captures/* 객체만 고아 정리 후보 (users/*/snapshots/* 등은 제외)
      const match = CAPTURE_KEY_RE.exec(obj.key);
      if (!match) continue;
      const captureId = match[2];
      if (!captureId) continue;

      const uploadedMs =
        obj.uploaded instanceof Date ? obj.uploaded.getTime() : Date.parse(String(obj.uploaded));
      if (Number.isFinite(uploadedMs) && uploadedMs < orphanGraceCutoffMs) {
        captureCandidates.push({
          key: obj.key,
          captureId,
          size: Math.max(0, Math.floor(obj.size))
        });
      }
    }

    let orphanDeletedCount = 0;
    if (captureCandidates.length > 0) {
      // D1 쿼리 예산 보호(최대 5회 × 80 capture_id) 및 고아 20건 확보 시 즉시 조기 종료
      const uniqueCaptureIds = [...new Set(captureCandidates.map((c) => c.captureId))];
      const orphansToDelete: Array<{ key: string; captureId: string; size: number }> = [];

      for (
        let batchIdx = 0;
        batchIdx < CRON_MAX_CAPTURE_LOOKUP_QUERIES &&
        batchIdx * CRON_CAPTURE_LOOKUP_BATCH_SIZE < uniqueCaptureIds.length &&
        orphansToDelete.length < CRON_MAX_ORPHAN_DELETES_PER_RUN;
        batchIdx += 1
      ) {
        const idBatch = uniqueCaptureIds.slice(
          batchIdx * CRON_CAPTURE_LOOKUP_BATCH_SIZE,
          (batchIdx + 1) * CRON_CAPTURE_LOOKUP_BATCH_SIZE
        );
        const idBatchSet = new Set(idBatch);
        const lookup = await findRegisteredCaptureR2Keys(env.DB, idBatch);

        for (const candidate of captureCandidates) {
          if (orphansToDelete.length >= CRON_MAX_ORPHAN_DELETES_PER_RUN) break;
          if (!idBatchSet.has(candidate.captureId)) continue;

          // D1 captures 표에 capture_id 행이 존재하면(capture_json 파싱 실패·손상 포함) 절대 삭제 금지
          if (
            lookup.registeredCaptureIds.has(candidate.captureId) ||
            lookup.registeredR2Keys.has(candidate.key)
          ) {
            continue;
          }
          orphansToDelete.push(candidate);
        }
      }

      if (orphansToDelete.length > 0) {
        // R2 batch delete(string[])는 단일 R2 서브요청으로 최대 20건 일괄 삭제
        await env.MEDIA_BUCKET.delete(orphansToDelete.map((o) => o.key));
        orphanDeletedCount = orphansToDelete.length;
        for (const deleted of orphansToDelete) {
          accumBytes = Math.max(0, accumBytes - deleted.size);
        }
      }
    }

    if (listed.truncated && listed.cursor) {
      await upsertAppMetaBatch(
        env.DB,
        [
          { key: APP_META_R2_SCAN_CURSOR, value: listed.cursor },
          { key: APP_META_R2_SCAN_ACCUM_BYTES, value: String(accumBytes) },
          { key: APP_META_R2_SCAN_CONSECUTIVE_FAILURES, value: '0' }
        ],
        nowIso
      );
      return {
        status: 'ok',
        listedCount: listed.objects.length,
        orphanDeletedCount,
        scanCompletedCycle: false,
        cachedUsageBytes: null,
        consecutiveFailures: 0,
        cursorReset: false
      };
    }

    // 전체 순회 1바퀴 완료: r2_usage_bytes 확정 캐시 & 커서/누계/실패 횟수 초기화
    await upsertAppMetaBatch(
      env.DB,
      [
        { key: APP_META_R2_USAGE_BYTES, value: String(accumBytes) },
        { key: APP_META_R2_USAGE_UPDATED_AT, value: nowIso },
        { key: APP_META_R2_SCAN_CURSOR, value: '' },
        { key: APP_META_R2_SCAN_ACCUM_BYTES, value: '0' },
        { key: APP_META_R2_SCAN_CONSECUTIVE_FAILURES, value: '0' }
      ],
      nowIso
    );

    return {
      status: 'ok',
      listedCount: listed.objects.length,
      orphanDeletedCount,
      scanCompletedCycle: true,
      cachedUsageBytes: accumBytes,
      consecutiveFailures: 0,
      cursorReset: false
    };
  } catch (err) {
    // 저장된 커서/페이지 처리 실패 시 무한 고착을 막기 위해 커서·누계 초기화 + 연속 실패 횟수 기록
    const nextFailures = safePrevFailures + 1;
    const hadCursor = Boolean(savedCursor);
    await upsertAppMetaBatch(
      env.DB,
      [
        { key: APP_META_R2_SCAN_CURSOR, value: '' },
        { key: APP_META_R2_SCAN_ACCUM_BYTES, value: '0' },
        { key: APP_META_R2_SCAN_CONSECUTIVE_FAILURES, value: String(nextFailures) }
      ],
      nowIso
    ).catch(() => undefined);

    return {
      status: 'error',
      listedCount: 0,
      orphanDeletedCount: 0,
      scanCompletedCycle: false,
      cachedUsageBytes: null,
      consecutiveFailures: nextFailures,
      cursorReset: hadCursor,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * 매시간 Cron Trigger 실행기:
 * - 세 작업(순위 추적, usage_daily 정리, R2 스캔·고아 정리)을 각각 독립 try/catch로 끝까지 실행합니다.
 * - 실행 요약을 console.info로 기록합니다.
 * - 1건이라도 오류가 있으면 console.error 출력 후 ScheduledRunError를 throw해
 *   Cloudflare Cron 실행 이력에 실패로 기록되게 합니다.
 */
export async function runScheduledTasks(
  env: WorkerBindings,
  now = new Date()
): Promise<ScheduledRunResult> {
  const ranAt = now.toISOString();

  let rankTracking: RankTrackingTaskResult;
  try {
    rankTracking = await runRankTrackingTask(env, now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    rankTracking = {
      status: 'error',
      kstToday: getKstDateString(now),
      checkedPairs: 0,
      completedPosts: 0,
      nonOkResponses: 0,
      errors: [`rankTracking: ${msg}`]
    };
  }

  let usageCleanup: UsageCleanupTaskResult;
  try {
    usageCleanup = await runUsageDailyCleanupTask(env, now);
  } catch (err) {
    usageCleanup = {
      status: 'error',
      cutoffDate: addDaysToYmd(getPacificDateString(now), -USAGE_DAILY_RETENTION_DAYS),
      deletedRows: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  let r2Maintenance: R2MaintenanceTaskResult;
  try {
    r2Maintenance = await runR2MaintenanceTask(env, now);
  } catch (err) {
    r2Maintenance = {
      status: 'error',
      listedCount: 0,
      orphanDeletedCount: 0,
      scanCompletedCycle: false,
      cachedUsageBytes: null,
      consecutiveFailures: 1,
      cursorReset: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const errors: string[] = [
    ...rankTracking.errors,
    ...(usageCleanup.error ? [`usageCleanup: ${usageCleanup.error}`] : []),
    ...(r2Maintenance.error ? [`r2Maintenance: ${r2Maintenance.error}`] : [])
  ];

  const result: ScheduledRunResult = {
    ranAt,
    rankTracking,
    usageCleanup,
    r2Maintenance,
    errors
  };

  console.info(
    '[scheduled] summary',
    JSON.stringify({
      ranAt,
      checkedPairs: rankTracking.checkedPairs,
      completedPosts: rankTracking.completedPosts,
      nonOkResponses: rankTracking.nonOkResponses,
      deletedUsageRows: usageCleanup.deletedRows,
      listedR2Objects: r2Maintenance.listedCount,
      deletedOrphans: r2Maintenance.orphanDeletedCount,
      scanCompletedCycle: r2Maintenance.scanCompletedCycle,
      cachedUsageBytes: r2Maintenance.cachedUsageBytes,
      r2ConsecutiveFailures: r2Maintenance.consecutiveFailures,
      errorCount: errors.length
    })
  );

  if (errors.length > 0) {
    console.error('[scheduled] errors', JSON.stringify({ ranAt, errors }));
    throw new ScheduledRunError(result);
  }

  return result;
}
