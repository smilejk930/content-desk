import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  extractNaverLogNo,
  getKstDateString,
  isManuscriptApprovedForExport,
  type DailyVisitorRequest,
  type DailyVisitorResponse,
  type DailyVisitorsListResponse,
  type ManuscriptsListResponse,
  type PublishedPostResponse,
  type PublishedPostsListResponse,
  type RegisterPublishedPostRequest
} from '@content-desk/shared';
import {
  fetchManuscripts,
  fetchPublishedPosts,
  fetchVisitors,
  getApiErrorMessage,
  registerPublishedPost,
  upsertVisitor
} from '../lib/api-client';
import { StatusBadge } from '../components/StatusBadge';

export interface PublishTrackerPageProps {
  initialManuscriptId?: string | null;
  listManuscripts?: () => Promise<ManuscriptsListResponse>;
  listPublishedPosts?: () => Promise<PublishedPostsListResponse>;
  submitPublishedPost?: (input: RegisterPublishedPostRequest) => Promise<PublishedPostResponse>;
  listVisitors?: () => Promise<DailyVisitorsListResponse>;
  saveVisitor?: (input: DailyVisitorRequest) => Promise<DailyVisitorResponse>;
}

export function PublishTrackerPage({
  initialManuscriptId = null,
  listManuscripts = () => fetchManuscripts(),
  listPublishedPosts = fetchPublishedPosts,
  submitPublishedPost = registerPublishedPost,
  listVisitors = fetchVisitors,
  saveVisitor = upsertVisitor
}: PublishTrackerPageProps) {
  const queryClient = useQueryClient();

  const [selectedManuscriptId, setSelectedManuscriptId] = useState<string>(
    initialManuscriptId ?? ''
  );
  const [postUrl, setPostUrl] = useState<string>('');
  const [keywordsRaw, setKeywordsRaw] = useState<string>('');
  const [postFeedback, setPostFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null
  );

  const [visitDate, setVisitDate] = useState<string>(() => getKstDateString());
  const [visitorCountRaw, setVisitorCountRaw] = useState<string>('');
  const [visitorFeedback, setVisitorFeedback] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (initialManuscriptId) {
      setSelectedManuscriptId(initialManuscriptId);
    }
  }, [initialManuscriptId]);

  const manuscriptsQuery = useQuery({
    queryKey: ['manuscripts'],
    queryFn: listManuscripts,
    retry: false
  });

  const postsQuery = useQuery({
    queryKey: ['published-posts'],
    queryFn: listPublishedPosts,
    retry: false
  });

  const visitorsQuery = useQuery({
    queryKey: ['visitors'],
    queryFn: listVisitors,
    retry: false
  });

  const approvedManuscripts = useMemo(
    () =>
      (manuscriptsQuery.data?.manuscripts ?? []).filter((ms) =>
        isManuscriptApprovedForExport(ms, ms.unresolved_verify_count)
      ),
    [manuscriptsQuery.data]
  );

  const effectiveManuscriptId =
    selectedManuscriptId || approvedManuscripts[0]?.manuscript_id || '';
  const detectedLogNo = useMemo(() => extractNaverLogNo(postUrl), [postUrl]);

  const registerMutation = useMutation({
    mutationFn: () => {
      const targetKeywords = keywordsRaw
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      if (!effectiveManuscriptId) {
        throw new Error('발행 등록할 승인 완료 원고를 선택해 주세요.');
      }
      if (!postUrl.trim()) {
        throw new Error('네이버 블로그 발행 URL을 입력해 주세요.');
      }
      if (targetKeywords.length === 0 || targetKeywords.length > 5) {
        throw new Error('타겟 키워드는 1~5개까지 쉼표(,)로 구분해 입력해 주세요.');
      }
      return submitPublishedPost({
        manuscript_id: effectiveManuscriptId,
        post_url: postUrl.trim(),
        ...(detectedLogNo ? { log_no: detectedLogNo } : {}),
        target_keywords: targetKeywords
      });
    },
    onSuccess: (res) => {
      setPostUrl('');
      setKeywordsRaw('');
      setPostFeedback({
        tone: 'success',
        text: `발행 글(logNo: ${res.post.log_no})을 등록했습니다. ${res.post.track_until}까지 매일 순위를 자동 추적합니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['published-posts'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (err) => {
      setPostFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '발행 URL 등록에 실패했습니다.')
      });
    }
  });

  const visitorMutation = useMutation({
    mutationFn: () => {
      const count = Number.parseInt(visitorCountRaw, 10);
      if (!Number.isInteger(count) || count < 0) {
        throw new Error('방문자 수는 0 이상의 정수로 입력해 주세요.');
      }
      return saveVisitor({
        visit_date: visitDate,
        visitor_count: count
      });
    },
    onSuccess: (res) => {
      setVisitorFeedback({
        tone: 'success',
        text: `${res.visitor.visit_date} 일일 방문자 수(${res.visitor.visitor_count.toLocaleString()}명)를 저장했습니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['visitors'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (err) => {
      setVisitorFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '방문자 수 저장에 실패했습니다.')
      });
    }
  });

  return (
    <div className="flex flex-col gap-5">
      {/* 1. 발행 URL(logNo) 등록 */}
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold text-brand">발행 URL 등록 및 검색 순위 추적</h2>
            <p className="mt-1 text-sm text-ink-soft">
              직접 발행한 네이버 블로그 글 URL을 등록하면 30일간 하루 1회 네이버 블로그 검색
              API(blog.json, 상위 100위) 기준 순위 근사치를 자동 기록합니다.
            </p>
          </div>
          <StatusBadge tone="neutral" icon="30d" label="검색 API 기준 순위(근사치)" />
        </div>

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            registerMutation.mutate();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>승인 완료 원고 선택</span>
            <select
              aria-label="승인 완료 원고 선택"
              value={effectiveManuscriptId}
              onChange={(e) => setSelectedManuscriptId(e.target.value)}
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            >
              {approvedManuscripts.length === 0 ? (
                <option value="">승인 완료된 원고가 없습니다</option>
              ) : (
                approvedManuscripts.map((ms) => (
                  <option key={ms.manuscript_id} value={ms.manuscript_id}>
                    {ms.selected_title} (v{ms.version})
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>네이버 블로그 발행 URL</span>
            <input
              type="url"
              value={postUrl}
              onChange={(e) => setPostUrl(e.target.value)}
              placeholder="https://blog.naver.com/myblog/223456789012 또는 PostView.naver?logNo=..."
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
            {postUrl.trim().length > 0 && (
              <span className="text-xs text-ink-soft">
                {detectedLogNo
                  ? `추출된 logNo: ${detectedLogNo}`
                  : 'URL 끝 숫자 또는 logNo= 파라미터를 확인할 수 없습니다.'}
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>추적할 타겟 키워드 (쉼표 구분, 1~5개)</span>
            <input
              type="text"
              value={keywordsRaw}
              onChange={(e) => setKeywordsRaw(e.target.value)}
              placeholder="예: 클라우드플레어 워커스, D1 무료 한도"
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
          </label>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="submit"
              disabled={!effectiveManuscriptId || registerMutation.isPending}
              className="pill-btn min-h-[44px] bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:opacity-45"
            >
              {registerMutation.isPending ? '등록 중...' : '발행 URL 등록'}
            </button>
          </div>
        </form>

        {postFeedback && (
          <p
            role={postFeedback.tone === 'danger' ? 'alert' : 'status'}
            className={`mt-3 rounded-lg px-3.5 py-2.5 text-sm ${
              postFeedback.tone === 'danger'
                ? 'bg-danger-bg text-danger'
                : 'bg-success-bg text-brand'
            }`}
          >
            {postFeedback.text}
          </p>
        )}
      </section>

      {/* 2. 발행 글 및 검색 API 순위 근사치 이력 */}
      <section className="card-surface p-6">
        <h3 className="text-lg font-semibold text-ink">
          등록된 발행 글 ({postsQuery.data?.posts.length ?? 0}건)
        </h3>
        <p className="mt-0.5 text-xs text-ink-soft">
          네이버 검색 API(blog.json) 순서는 실제 통합검색·스마트블록 노출과 다를 수 있으므로 참고용
          근사치로 표시됩니다.
        </p>

        {(postsQuery.data?.posts ?? []).length === 0 ? (
          <p className="mt-3 rounded-xl bg-surface-subtle p-4 text-sm text-ink-soft">
            아직 등록된 발행 글이 없습니다.
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {(postsQuery.data?.posts ?? []).map((post) => (
              <article
                key={post.post_id}
                data-testid={`published-post-${post.log_no}`}
                className="rounded-xl border border-ink/10 bg-surface-subtle p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">
                      {post.manuscript_title || `원고 ${post.manuscript_id}`}
                    </p>
                    <p className="mt-0.5 break-all text-xs text-ink-soft">
                      <a
                        href={post.post_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand underline"
                      >
                        {post.post_url}
                      </a>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge tone="neutral" icon="#" label={post.category_name} />
                    <StatusBadge tone="neutral" icon="ID" label={`logNo ${post.log_no}`} />
                  </div>
                </div>

                <p className="mt-2 text-xs text-ink-soft">
                  추적 종료일(KST): {post.track_until} · 최근 조회일:{' '}
                  {post.last_tracked_date ?? '조회 대기'}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {post.target_keywords.map((kw) => {
                    const latest = post.latest_ranks.find((r) => r.keyword === kw);
                    const label = !latest
                      ? `${kw}: 조회 대기`
                      : latest.rank !== null
                        ? `${kw}: ${latest.rank}위 (근사치)`
                        : `${kw}: 100위 밖`;
                    return (
                      <StatusBadge
                        key={kw}
                        tone={
                          !latest
                            ? 'neutral'
                            : latest.rank !== null && latest.rank <= 20
                              ? 'success'
                              : 'warning'
                        }
                        icon={latest?.rank !== null && latest ? '★' : '•'}
                        label={label}
                      />
                    );
                  })}
                </div>

                {post.rank_history.length > 0 && (
                  <div className="mt-3 rounded-lg bg-surface p-3 text-xs">
                    <p className="font-semibold text-ink">최근 순위 이력 (KST)</p>
                    <ul className="mt-1.5 flex flex-col gap-1 text-ink-soft">
                      {post.rank_history.slice(0, 6).map((h) => (
                        <li key={h.id} className="flex items-center justify-between gap-2">
                          <span>
                            {h.checked_date} · {h.keyword}
                          </span>
                          <span className="font-mono text-ink">
                            {h.rank !== null ? `${h.rank}위` : '100위 밖'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 3. 일일 방문자 수 기록 (KST) */}
      <section className="card-surface p-6">
        <h3 className="text-lg font-semibold text-brand">일일 방문자 수 기록 (KST)</h3>
        <p className="mt-1 text-sm text-ink-soft">
          네이버 크리에이터 어드바이저의 일일 방문자 수를 날짜별(KST)로 직접 기록합니다.
        </p>

        <form
          className="mt-4 grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            visitorMutation.mutate();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>날짜 (KST YYYY-MM-DD)</span>
            <input
              type="date"
              aria-label="방문 날짜 (KST)"
              value={visitDate}
              onChange={(e) => setVisitDate(e.target.value)}
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>일일 방문자 수</span>
            <input
              type="number"
              min={0}
              step={1}
              aria-label="일일 방문자 수"
              value={visitorCountRaw}
              onChange={(e) => setVisitorCountRaw(e.target.value)}
              placeholder="예: 320"
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={visitorMutation.isPending || visitorCountRaw.trim() === ''}
              className="pill-btn min-h-[44px] w-full bg-cta px-5 text-sm font-semibold text-ink-inverse disabled:opacity-45"
            >
              {visitorMutation.isPending ? '저장 중...' : '방문자 수 저장'}
            </button>
          </div>
        </form>

        {visitorFeedback && (
          <p
            role={visitorFeedback.tone === 'danger' ? 'alert' : 'status'}
            className={`mt-3 rounded-lg px-3.5 py-2.5 text-sm ${
              visitorFeedback.tone === 'danger'
                ? 'bg-danger-bg text-danger'
                : 'bg-success-bg text-brand'
            }`}
          >
            {visitorFeedback.text}
          </p>
        )}

        {(visitorsQuery.data?.visitors ?? []).length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-ink/10 text-xs text-ink-soft">
                  <th className="py-2 pr-4">날짜 (KST)</th>
                  <th className="py-2 pr-4">방문자 수</th>
                  <th className="py-2">수정 시각</th>
                </tr>
              </thead>
              <tbody>
                {(visitorsQuery.data?.visitors ?? []).slice(0, 14).map((v) => (
                  <tr key={v.visit_date} className="border-b border-ink/5">
                    <td className="py-2 pr-4 font-mono text-ink">{v.visit_date}</td>
                    <td className="py-2 pr-4 font-semibold text-brand">
                      {v.visitor_count.toLocaleString()}명
                    </td>
                    <td className="py-2 text-xs text-ink-soft">{v.updated_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
