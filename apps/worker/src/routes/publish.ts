import { Hono } from 'hono';
import { sValidator } from '@hono/standard-validator';
import {
  addDaysToYmd,
  BACKUP_REMINDER_DAYS,
  dailyVisitorRequestSchema,
  extractNaverLogNo,
  getKstDateString,
  getKstWeekStartDate,
  getNextResetIso,
  isManuscriptApprovedForExport,
  kstDateStartToUtcIso,
  NAVER_BLOG_ID_RE,
  R2_FREE_LIMIT_BYTES,
  R2_USAGE_WARN_RATIO,
  registerPublishedPostSchema,
  updateSettingsRequestSchema,
  type CRankCategoryShare
} from '@content-desk/shared';
import type { WorkerEnv } from '../env.js';
import { AppError } from '../middleware/error-handler.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import { getGlobalR2UsageEstimate } from '../repositories/cron.repo.js';
import { getManuscriptById } from '../repositories/manuscripts.repo.js';
import {
  countOwnerPublishedPosts,
  createPublishedPost,
  getApprovalStatsKst,
  getCRankCategoryDistribution,
  getPublishedPostById,
  listDailyVisitors,
  listPublishedPostsWithRanks,
  upsertDailyVisitor
} from '../repositories/publish.repo.js';
import { deleteUserMeta, getUserMeta, upsertUserMeta } from '../repositories/user-meta.repo.js';
import { getGlobalQuotaSummary } from '../services/quota-ledger.js';

const USER_META_LAST_EXPORT = 'last_full_export_at';
const USER_META_NAVER_BLOG_ID = 'naver_blog_id';

function throwValidationError(
  issues: readonly { message: string; path?: readonly unknown[] }[]
): never {
  const firstMessage = issues[0]?.message ?? '요청 값이 올바르지 않습니다.';
  throw new AppError(400, 'VALIDATION_ERROR', firstMessage, {
    details: {
      issues: issues.map((issue) => ({
        message: issue.message,
        path: issue.path
      }))
    }
  });
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

function computeBackupStatus(
  lastExportIso: string | null,
  now: Date,
  hasData: boolean
): {
  last_full_export_at: string | null;
  days_since_export: number | null;
  reminder_due: boolean;
} {
  if (!lastExportIso) {
    return {
      last_full_export_at: null,
      days_since_export: null,
      reminder_due: hasData
    };
  }
  const exportedMs = Date.parse(lastExportIso);
  if (!Number.isFinite(exportedMs)) {
    return {
      last_full_export_at: null,
      days_since_export: null,
      reminder_due: hasData
    };
  }
  const daysSince = Math.max(0, Math.floor((now.getTime() - exportedMs) / 86_400_000));
  return {
    last_full_export_at: lastExportIso,
    days_since_export: daysSince,
    reminder_due: daysSince >= BACKUP_REMINDER_DAYS
  };
}

export const publishRoute = new Hono<WorkerEnv>()
  .get('/published-posts', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const posts = await listPublishedPostsWithRanks(scope, c.env.DB);
    return c.json({ posts }, 200);
  })
  .post(
    '/published-posts',
    firebaseAuth,
    sValidator('json', registerPublishedPostSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');
      const now = new Date();

      const record = await getManuscriptById(scope, c.env.DB, body.manuscript_id);
      if (!record) {
        throw new AppError(404, 'NOT_FOUND', '대상 원고를 찾을 수 없습니다.');
      }

      if (!isManuscriptApprovedForExport(record.manuscript, record.unresolved_verify_count)) {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          '검증 완료 및 승인된 최신 버전 원고만 발행 URL을 등록할 수 있습니다.'
        );
      }

      const parsedUrl = new URL(body.post_url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new AppError(400, 'VALIDATION_ERROR', '발행 URL은 http 또는 https만 허용됩니다.');
      }

      const extractedLogNo = extractNaverLogNo(body.post_url);
      let normalizedLogNo: string;
      if (body.log_no) {
        if (extractedLogNo && extractedLogNo !== body.log_no) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            `입력한 logNo(${body.log_no})가 발행 URL의 글 번호(${extractedLogNo})와 일치하지 않습니다.`
          );
        }
        normalizedLogNo = body.log_no;
      } else {
        if (!extractedLogNo) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            '발행 URL에서 네이버 블로그 글 번호(logNo)를 추출할 수 없습니다. (경로 끝 숫자 또는 logNo= 파라미터 필요)'
          );
        }
        normalizedLogNo = extractedLogNo;
      }

      const uniqueKeywords = [...new Set(body.target_keywords.map((k) => k.trim()).filter(Boolean))];
      if (uniqueKeywords.length === 0) {
        throw new AppError(400, 'VALIDATION_ERROR', '타겟 키워드를 1개 이상 입력해 주세요.');
      }

      const publishedAtIso = body.published_at ?? now.toISOString();
      const publishedKstDate = getKstDateString(new Date(publishedAtIso));
      const trackUntilYmd = addDaysToYmd(publishedKstDate, 30);
      const postId = crypto.randomUUID();

      try {
        await createPublishedPost(scope, c.env.DB, {
          postId,
          manuscriptId: record.manuscript.manuscript_id,
          categoryId: record.category_id,
          logNo: normalizedLogNo,
          postUrl: body.post_url,
          targetKeywords: uniqueKeywords,
          publishedAtIso,
          trackUntilYmd
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          throw new AppError(
            409,
            'CONFLICT',
            `이미 등록된 네이버 블로그 글 번호(logNo=${normalizedLogNo})입니다.`
          );
        }
        throw err;
      }

      const created = await getPublishedPostById(scope, c.env.DB, postId);
      if (!created) {
        throw new AppError(500, 'INTERNAL_ERROR', '등록된 발행 글을 조회하지 못했습니다.');
      }

      return c.json({ post: created }, 201);
    }
  )
  .get('/visitors', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const visitors = await listDailyVisitors(scope, c.env.DB, { limit: 90 });
    return c.json({ visitors }, 200);
  })
  .put(
    '/visitors',
    firebaseAuth,
    sValidator('json', dailyVisitorRequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');
      const nowIso = new Date().toISOString();
      const visitor = await upsertDailyVisitor(scope, c.env.DB, {
        visitDate: body.visit_date,
        visitorCount: body.visitor_count,
        nowIso
      });
      return c.json({ visitor }, 200);
    }
  )
  .get('/dashboard/summary', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const now = new Date();
    const kstToday = getKstDateString(now);
    const kstWeekStart = getKstWeekStartDate(now);
    const kstTodayStartUtcIso = kstDateStartToUtcIso(kstToday);
    const kstWeekStartUtcIso = kstDateStartToUtcIso(kstWeekStart);
    const kst30DaysStartUtcIso = kstDateStartToUtcIso(addDaysToYmd(kstToday, -29));

    const [
      approvalStats,
      cRankDist,
      globalQuotas,
      r2Estimate,
      lastExportMeta,
      recentVisitors,
      publishedCount
    ] = await Promise.all([
      getApprovalStatsKst(scope, c.env.DB, {
        kstTodayStartUtcIso,
        kstWeekStartUtcIso
      }),
      getCRankCategoryDistribution(scope, c.env.DB, kst30DaysStartUtcIso),
      getGlobalQuotaSummary(c.env.DB, now),
      getGlobalR2UsageEstimate(c.env.DB),
      getUserMeta(scope, c.env.DB, USER_META_LAST_EXPORT),
      listDailyVisitors(scope, c.env.DB, { limit: 14 }),
      countOwnerPublishedPosts(scope, c.env.DB)
    ]);

    const cRankTotal = cRankDist.rows.reduce((sum, r) => sum + r.cnt, 0);
    const cRankCategories: CRankCategoryShare[] = cRankDist.rows.map((r) => ({
      category_id: r.category_id,
      display_name: r.display_name,
      count: r.cnt,
      share: cRankTotal > 0 ? Number((r.cnt / cRankTotal).toFixed(4)) : 0
    }));
    const topCategoryShare = cRankCategories[0]?.share ?? 0;
    const categoryCount = cRankCategories.length;

    let cRankWarning = false;
    let cRankWarningReason: string | null = null;
    if (cRankTotal >= 5) {
      if (topCategoryShare < 0.6 && categoryCount >= 3) {
        cRankWarning = true;
        cRankWarningReason = `최근 30일 ${cRankTotal}건이 ${categoryCount}개 카테고리에 분산되었고 최다 카테고리 비중이 ${Math.round(topCategoryShare * 100)}%(60% 미만)입니다.`;
      } else if (topCategoryShare < 0.6) {
        cRankWarning = true;
        cRankWarningReason = `최근 30일 ${cRankTotal}건 중 최다 카테고리 비중이 ${Math.round(topCategoryShare * 100)}%로 60% 미만입니다.`;
      } else if (categoryCount >= 3) {
        cRankWarning = true;
        cRankWarningReason = `최근 30일 ${cRankTotal}건이 ${categoryCount}개 카테고리(3개 이상)에 분산되어 네이버 C-Rank 집중도가 낮아질 수 있습니다.`;
      }
    }

    const d1Reads = globalQuotas.find((q) => q.provider === 'd1_reads');
    const d1Writes = globalQuotas.find((q) => q.provider === 'd1_writes');
    const d1ReadsRatio = d1Reads?.ratio ?? 0;
    const d1WritesRatio = d1Writes?.ratio ?? 0;

    const r2Ratio = Number((r2Estimate.usedBytes / R2_FREE_LIMIT_BYTES).toFixed(4));
    const r2Warning = r2Ratio >= R2_USAGE_WARN_RATIO;

    const backup = computeBackupStatus(
      lastExportMeta?.value ?? null,
      now,
      approvalStats.totalApprovedCount > 0 || publishedCount > 0
    );

    return c.json(
      {
        kst_today: kstToday,
        kst_week_start: kstWeekStart,
        approvals: {
          today_count: approvalStats.todayCount,
          week_count: approvalStats.weekCount,
          total_approved_count: approvalStats.totalApprovedCount
        },
        c_rank: {
          basis: cRankDist.basis,
          window_days: 30 as const,
          total_count: cRankTotal,
          category_count: categoryCount,
          top_category_share: topCategoryShare,
          warning: cRankWarning,
          warning_reason: cRankWarningReason,
          categories: cRankCategories
        },
        global_quotas: globalQuotas,
        d1_warning: {
          warning: Boolean(d1Reads?.warning || d1Writes?.warning),
          blocked: Boolean(d1Reads?.generation_blocked || d1Writes?.generation_blocked),
          reads_ratio: d1ReadsRatio,
          writes_ratio: d1WritesRatio,
          reset_at: getNextResetIso('UTC', now)
        },
        r2_usage: {
          used_bytes: r2Estimate.usedBytes,
          limit_bytes: R2_FREE_LIMIT_BYTES,
          ratio: r2Ratio,
          warning: r2Warning,
          source: r2Estimate.source,
          updated_at: r2Estimate.updatedAt
        },
        backup,
        recent_visitors: recentVisitors,
        published_count: publishedCount,
        bridge_status: {
          phase: 'M2_PLANNED' as const,
          status: 'BRIDGE_OFFLINE' as const,
          message:
            'PC 자동 임시저장 브리지는 M2(Phase 5)에서 제공 예정입니다. 현재는 갤럭시 탭·PC 공통 수동 복사 패널을 이용해 주세요.'
        }
      },
      200
    );
  })
  .get('/settings', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const now = new Date();
    const [blogIdMeta, lastExportMeta, publishedCount, approvalStats] = await Promise.all([
      getUserMeta(scope, c.env.DB, USER_META_NAVER_BLOG_ID),
      getUserMeta(scope, c.env.DB, USER_META_LAST_EXPORT),
      countOwnerPublishedPosts(scope, c.env.DB),
      getApprovalStatsKst(scope, c.env.DB, {
        kstTodayStartUtcIso: kstDateStartToUtcIso(getKstDateString(now)),
        kstWeekStartUtcIso: kstDateStartToUtcIso(getKstWeekStartDate(now))
      })
    ]);

    const rawBlogId = blogIdMeta?.value?.trim() ?? '';
    const naverBlogId = rawBlogId && NAVER_BLOG_ID_RE.test(rawBlogId) ? rawBlogId : null;
    const backup = computeBackupStatus(
      lastExportMeta?.value ?? null,
      now,
      approvalStats.totalApprovedCount > 0 || publishedCount > 0
    );

    return c.json(
      {
        naver_blog_id: naverBlogId,
        last_full_export_at: backup.last_full_export_at,
        backup_reminder_due: backup.reminder_due,
        days_since_export: backup.days_since_export
      },
      200
    );
  })
  .put(
    '/settings',
    firebaseAuth,
    sValidator('json', updateSettingsRequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');
      const now = new Date();
      const nowIso = now.toISOString();

      if (body.naver_blog_id === null) {
        await deleteUserMeta(scope, c.env.DB, USER_META_NAVER_BLOG_ID);
      } else {
        await upsertUserMeta(scope, c.env.DB, USER_META_NAVER_BLOG_ID, body.naver_blog_id, nowIso);
      }

      const [lastExportMeta, publishedCount, approvalStats] = await Promise.all([
        getUserMeta(scope, c.env.DB, USER_META_LAST_EXPORT),
        countOwnerPublishedPosts(scope, c.env.DB),
        getApprovalStatsKst(scope, c.env.DB, {
          kstTodayStartUtcIso: kstDateStartToUtcIso(getKstDateString(now)),
          kstWeekStartUtcIso: kstDateStartToUtcIso(getKstWeekStartDate(now))
        })
      ]);

      const backup = computeBackupStatus(
        lastExportMeta?.value ?? null,
        now,
        approvalStats.totalApprovedCount > 0 || publishedCount > 0
      );

      return c.json(
        {
          naver_blog_id: body.naver_blog_id,
          last_full_export_at: backup.last_full_export_at,
          backup_reminder_due: backup.reminder_due,
          days_since_export: backup.days_since_export
        },
        200
      );
    }
  );
