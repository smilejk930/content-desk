import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DashboardSummaryResponse,
  ExportResponse,
  MeResponse,
  QuotaProvider
} from '@content-desk/shared';
import {
  fetchDashboardSummary,
  getApiErrorMessage,
  triggerExport
} from '../lib/api-client';
import { StatusBadge } from '../components/StatusBadge';

export interface DashboardPageProps {
  me: MeResponse;
  d1LimitResetAt: string | null;
  loadSummary?: () => Promise<DashboardSummaryResponse>;
  runExport?: () => Promise<ExportResponse>;
  onNavigateTab?: (
    tab: 'categories' | 'upload' | 'discovery' | 'manuscripts' | 'copy-panel' | 'publish' | 'settings'
  ) => void;
}

const PROVIDER_LABELS: Record<QuotaProvider, string> = {
  naver_search: '네이버 검색 API',
  naver_datalab: '네이버 데이터랩',
  naver_searchad: '네이버 검색광고',
  gemini_text: 'Gemini 텍스트 (무료)',
  gemini_image: 'Gemini 이미지 (무료)',
  d1_reads: 'D1 읽기 (보수 상한)',
  d1_writes: 'D1 쓰기 (보수 상한)'
};

function formatBytesHuman(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

export function downloadExportJsonFile(data: ExportResponse): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const datePart = data.exported_at.slice(0, 10);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `content-desk-backup-${datePart}.json`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export function DashboardPage({
  me,
  d1LimitResetAt,
  loadSummary = fetchDashboardSummary,
  runExport = triggerExport,
  onNavigateTab
}: DashboardPageProps) {
  const queryClient = useQueryClient();
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const summaryQuery = useQuery({
    queryKey: ['dashboard-summary', me.uid],
    queryFn: loadSummary,
    retry: false
  });

  const exportMutation = useMutation({
    mutationFn: runExport,
    onSuccess: (data) => {
      downloadExportJsonFile(data);
      setExportMessage(`본인 데이터 전체 JSON 백업을 내려받았습니다 (시각: ${data.exported_at}).`);
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => {
      setExportMessage(getApiErrorMessage(err, '데이터 내보내기에 실패했습니다.'));
    }
  });

  const summary = summaryQuery.data ?? null;
  const isAdmin = me.role === 'admin';

  const quotaAlerts = (summary?.global_quotas ?? []).filter(
    (q) => q.daily_cap > 0 && (q.warning || q.generation_blocked)
  );
  const hasGlobalQuotaAlert =
    quotaAlerts.length > 0 || Boolean(summary?.d1_warning.warning || summary?.d1_warning.blocked);

  return (
    <div className="flex flex-col gap-5">
      {/* 1. 계정 연결 상태 및 빠른 이동 */}
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-brand">인증 및 백엔드 연결 정상</h2>
            <p className="mt-1 text-sm text-ink-soft">
              {me.email ?? me.uid}
              {summary ? ` · 기준일(KST) ${summary.kst_today}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              tone={isAdmin ? 'success' : 'neutral'}
              icon={isAdmin ? '★' : '•'}
              label={isAdmin ? '관리자' : '일반 사용자'}
            />
            <StatusBadge
              tone={me.d1_connected ? 'success' : 'warning'}
              icon={me.d1_connected ? '✓' : '!'}
              label={me.d1_connected ? 'D1 연결됨' : 'D1 확인 필요'}
            />
          </div>
        </div>

        {summary && (
          <dl className="mt-5 grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-surface-subtle p-3.5">
              <dt className="text-xs text-ink-soft">오늘 승인 (KST)</dt>
              <dd className="mt-1 text-xl font-semibold text-brand">
                {summary.approvals.today_count}건
              </dd>
            </div>
            <div className="rounded-lg bg-surface-subtle p-3.5">
              <dt className="text-xs text-ink-soft">이번 주 승인 (KST)</dt>
              <dd className="mt-1 text-xl font-semibold text-ink">
                {summary.approvals.week_count}건
              </dd>
            </div>
            <div className="rounded-lg bg-surface-subtle p-3.5">
              <dt className="text-xs text-ink-soft">발행 추적 글</dt>
              <dd className="mt-1 text-xl font-semibold text-ink">{summary.published_count}건</dd>
            </div>
            <div className="rounded-lg bg-surface-subtle p-3.5">
              <dt className="text-xs text-ink-soft">최근 일일 방문자</dt>
              <dd className="mt-1 text-xl font-semibold text-ink">
                {summary.recent_visitors[0]
                  ? `${summary.recent_visitors[0].visitor_count.toLocaleString()}명`
                  : '-'}
              </dd>
            </div>
          </dl>
        )}

        {onNavigateTab && (
          <div className="mt-5 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => onNavigateTab('upload')}
              className="pill-btn border border-cta bg-surface px-4 text-sm font-semibold text-cta"
            >
              현장 사진·메모 올리기
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('discovery')}
              className="pill-btn bg-cta px-4 text-sm font-semibold text-ink-inverse"
            >
              글감 발굴
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('manuscripts')}
              className="pill-btn bg-cta px-4 text-sm font-semibold text-ink-inverse"
            >
              원고 편집·검증
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('copy-panel')}
              className="pill-btn border border-cta bg-surface px-4 text-sm font-semibold text-cta"
            >
              수동 복사·공유
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('publish')}
              className="pill-btn border border-cta bg-surface px-4 text-sm font-semibold text-cta"
            >
              발행·순위 추적
            </button>
          </div>
        )}
      </section>

      {/* 2. 대시보드 경고 4종 (C-Rank, 전역 한도, R2 80%, 30일 백업) */}
      {summary && (
        <div className="flex flex-col gap-3">
          {/* 경고 1: C-Rank 분산 경고 */}
          {summary.c_rank.warning && (
            <section
              data-testid="warning-c-rank"
              role="alert"
              className="rounded-xl border border-ink/15 bg-warning px-5 py-4 text-warning-ink"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">⚠ 네이버 C-Rank 주제 분산 경고</p>
                <span className="text-xs font-medium">
                  최근 30일 ({summary.c_rank.basis === 'published_posts' ? '발행 글' : '승인 원고'}{' '}
                  {summary.c_rank.total_count}건)
                </span>
              </div>
              <p className="mt-1 text-xs">{summary.c_rank.warning_reason}</p>
            </section>
          )}

          {/* 경고 2: 전역 공유 한도 / D1 상한 경고 */}
          {hasGlobalQuotaAlert && (
            <section
              data-testid="warning-global-quota"
              role="alert"
              className="rounded-xl border border-danger/30 bg-danger-bg px-5 py-4 text-danger"
            >
              <p className="text-sm font-semibold">
                ⚠ 전체 사용자 공유 한도 주의 / 소진 안내
              </p>
              <p className="mt-1 text-xs">
                모든 등록 사용자가 오너 API 키와 무료 한도를 함께 사용합니다. 한도가 소진되면 유료
                전환 없이 각 제공자 초기화 시각까지 대기합니다.
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-xs">
                {quotaAlerts.map((q) => (
                  <li key={q.provider}>
                    • {PROVIDER_LABELS[q.provider]}: 남은 {q.remaining.toLocaleString()} /{' '}
                    {q.daily_cap.toLocaleString()} ({Math.round(q.ratio * 100)}%) · 초기화:{' '}
                    {q.reset_at}
                  </li>
                ))}
                {(summary.d1_warning.warning || summary.d1_warning.blocked) &&
                  !quotaAlerts.some((q) => q.provider === 'd1_reads' || q.provider === 'd1_writes') && (
                    <li>
                      • D1 보수 상한: 읽기 {Math.round(summary.d1_warning.reads_ratio * 100)}% / 쓰기{' '}
                      {Math.round(summary.d1_warning.writes_ratio * 100)}% · 초기화:{' '}
                      {summary.d1_warning.reset_at}
                    </li>
                  )}
              </ul>
            </section>
          )}

          {/* 경고 3: R2 80% 저장 용량 경고 */}
          {summary.r2_usage.warning && (
            <section
              data-testid="warning-r2-usage"
              role="alert"
              className="rounded-xl border border-ink/15 bg-warning px-5 py-4 text-warning-ink"
            >
              <p className="text-sm font-semibold">
                ⚠ Cloudflare R2 무료 저장 용량 80% 초과 경고 (
                {Math.round(summary.r2_usage.ratio * 100)}%)
              </p>
              <p className="mt-1 text-xs">
                현재 사용량 {formatBytesHuman(summary.r2_usage.used_bytes)} / 무료 한도{' '}
                {formatBytesHuman(summary.r2_usage.limit_bytes)} (
                {summary.r2_usage.source === 'r2_scan_cache' ? '크론 스캔 캐시' : 'D1 초기 추정'}).
                유료 과금을 피하기 위해 오래된 미사용 미디어를 점검하세요.
              </p>
            </section>
          )}

          {/* 경고 4: 30일 전체 백업 알림 */}
          {summary.backup.reminder_due && (
            <section
              data-testid="warning-backup-30d"
              role="alert"
              className="rounded-xl border border-brand/25 bg-success-bg px-5 py-4 text-brand"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">⚠ 본인 데이터 전체 백업 권장 (30일 주기)</p>
                  <p className="mt-1 text-xs">
                    {summary.backup.last_full_export_at
                      ? `마지막 전체 JSON 내보내기(${summary.backup.last_full_export_at.slice(0, 10)})로부터 ${summary.backup.days_since_export}일이 경과했습니다.`
                      : '아직 전체 JSON 백업을 실행한 기록이 없습니다.'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={exportMutation.isPending}
                  onClick={() => exportMutation.mutate()}
                  className="pill-btn bg-cta px-5 text-sm font-semibold text-ink-inverse disabled:opacity-50"
                >
                  {exportMutation.isPending ? '내보내기 중...' : '지금 전체 JSON 백업하기'}
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      {exportMessage && (
        <p role="status" className="rounded-lg bg-success-bg px-4 py-3 text-sm text-brand">
          {exportMessage}
        </p>
      )}

      {/* 3. 제공자별 남은 전역 공유 한도 & R2 용량 요약 (타인 사용량 비노출) */}
      {summary ? (
        <>
          <section className="card-surface p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-lg font-semibold text-ink">전체 사용자 공유 할당량 현황</h3>
                <p className="mt-0.5 text-xs text-ink-soft">
                  제공자별 남은 전역 한도와 초기화 시각만 표시합니다 (개인별 사용량은 비공개).
                </p>
              </div>
              <StatusBadge
                tone={summary.r2_usage.warning ? 'warning' : 'success'}
                icon="R2"
                label={`${formatBytesHuman(summary.r2_usage.used_bytes)} / 10 GiB (${Math.round(summary.r2_usage.ratio * 100)}%)`}
              />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {summary.global_quotas.map((q) => (
                <div
                  key={q.provider}
                  className="rounded-xl border border-ink/10 bg-surface-subtle p-3.5 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-ink">{PROVIDER_LABELS[q.provider]}</span>
                    <span className="font-mono text-brand">
                      남은 {q.remaining.toLocaleString()} / {q.daily_cap.toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 text-ink-soft">
                    기준일: {q.window_date} ({q.reset_tz}) · 초기화: {q.reset_at}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* 4. 최근 30일 카테고리 비중(C-Rank) & M2 브리지 상태 */}
          <section className="grid gap-5 sm:grid-cols-2">
            <div className="card-surface p-6">
              <h3 className="text-base font-semibold text-ink">최근 30일 카테고리 분포 (C-Rank)</h3>
              {summary.c_rank.categories.length === 0 ? (
                <p className="mt-2 text-xs text-ink-soft">
                  최근 30일 내 발행 글 또는 승인 완료 원고가 없습니다.
                </p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2 text-xs">
                  {summary.c_rank.categories.map((cat) => (
                    <li key={cat.category_id} className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{cat.display_name}</span>
                      <span className="font-mono text-brand">
                        {cat.count}건 ({Math.round(cat.share * 100)}%)
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card-surface p-6">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">PC 브리지 상태</h3>
                <StatusBadge tone="neutral" icon="M2" label={summary.bridge_status.status} />
              </div>
              <p className="mt-2 text-xs text-ink-soft">{summary.bridge_status.message}</p>
              {d1LimitResetAt && (
                <p className="mt-2 text-xs text-danger">
                  D1 일일 한도 초기화 예정: {d1LimitResetAt}
                </p>
              )}
            </div>
          </section>
        </>
      ) : (
        <section className="card-surface p-6">
          <p className="text-sm text-ink-soft">
            {summaryQuery.isLoading
              ? '대시보드 요약 지표를 불러오고 있습니다...'
              : '대시보드 요약 정보를 아직 불러오지 못했습니다.'}
          </p>
        </section>
      )}
    </div>
  );
}
