import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CapturesListResponse,
  CategoriesListResponse,
  CreateSourceSnapshotRequest,
  CreateSourceSnapshotResponse,
  DiscoverStep1Request,
  DiscoverStep1Response,
  DiscoverStep2Request,
  DiscoverStep2Response,
  DiscoverStep3Request,
  DiscoverStep3Response,
  SourceCandidate,
  TopicDiscoveryJSON,
  TopicFromCaptureRequest,
  TopicResponse,
  TopicsListResponse,
  TopicSourceCandidatesResponse,
  TopicYmylConfirmRequest
} from '@content-desk/shared';
import {
  ApiRequestError,
  confirmTopicYmyl,
  createTopicFromCapture,
  createTopicSourceSnapshot,
  discoverStep1Seeds,
  discoverStep2Datalab,
  discoverStep3Supply,
  fetchCaptures,
  fetchCategories,
  fetchTopics,
  fetchTopicSourceCandidates,
  getApiErrorMessage
} from '../lib/api-client';
import { StatusBadge } from '../components/StatusBadge';

export interface DiscoveryPageProps {
  listCategories?: () => Promise<CategoriesListResponse>;
  listCaptures?: () => Promise<CapturesListResponse>;
  listTopics?: () => Promise<TopicsListResponse>;
  runStep1?: (input: DiscoverStep1Request) => Promise<DiscoverStep1Response>;
  runStep2?: (input: DiscoverStep2Request) => Promise<DiscoverStep2Response>;
  runStep3?: (input: DiscoverStep3Request) => Promise<DiscoverStep3Response>;
  createFromCapture?: (input: TopicFromCaptureRequest) => Promise<TopicResponse>;
  confirmYmyl?: (id: string, input: TopicYmylConfirmRequest) => Promise<TopicResponse>;
  loadSourceCandidates?: (id: string) => Promise<TopicSourceCandidatesResponse>;
  saveSourceSnapshot?: (
    id: string,
    input: CreateSourceSnapshotRequest
  ) => Promise<CreateSourceSnapshotResponse>;
  onSelectTopicForManuscript?: (topicId: string) => void;
}

function parseKeywords(raw: string): string[] {
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function DiscoveryPage({
  listCategories = fetchCategories,
  listCaptures = () => fetchCaptures(),
  listTopics = () => fetchTopics(),
  runStep1 = discoverStep1Seeds,
  runStep2 = discoverStep2Datalab,
  runStep3 = discoverStep3Supply,
  createFromCapture = createTopicFromCapture,
  confirmYmyl = confirmTopicYmyl,
  loadSourceCandidates = fetchTopicSourceCandidates,
  saveSourceSnapshot = createTopicSourceSnapshot,
  onSelectTopicForManuscript
}: DiscoveryPageProps) {
  const queryClient = useQueryClient();

  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [extraKeywordsRaw, setExtraKeywordsRaw] = useState<string>('');
  const [includeTrends, setIncludeTrends] = useState<boolean>(true);
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);
  const [blockedKeywords, setBlockedKeywords] = useState<
    Array<{ keyword: string; stage: string; reason: string }>
  >([]);
  const [pipelineFeedback, setPipelineFeedback] = useState<{
    tone: 'success' | 'warning' | 'danger';
    text: string;
  } | null>(null);

  const [selectedCaptureId, setSelectedCaptureId] = useState<string>('');
  const [captureKeyword, setCaptureKeyword] = useState<string>('');
  const [captureBorderline, setCaptureBorderline] = useState<{
    payload: TopicFromCaptureRequest;
    reason: string;
  } | null>(null);

  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [candidatesState, setCandidatesState] = useState<{
    topicId: string;
    allowedDomains: string[];
    candidates: SourceCandidate[];
  } | null>(null);
  const [manualSourceUrl, setManualSourceUrl] = useState<string>('');
  const [unlistedDomainConfirm, setUnlistedDomainConfirm] = useState<{
    topicId: string;
    url: string;
    reason: string;
  } | null>(null);
  const [sourceFeedback, setSourceFeedback] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: listCategories,
    retry: false
  });

  const capturesQuery = useQuery({
    queryKey: ['captures'],
    queryFn: listCaptures,
    retry: false
  });

  const topicsQuery = useQuery({
    queryKey: ['topics'],
    queryFn: listTopics,
    retry: false
  });

  const trendCategories = (categoriesQuery.data?.categories ?? []).filter(
    (c) => c.discovery_mode === 'trend_first'
  );
  const effectiveCategoryId =
    selectedCategoryId || trendCategories[0]?.category_id || '';
  const effectiveCaptureId =
    selectedCaptureId || capturesQuery.data?.captures[0]?.capture_id || '';

  const topics = topicsQuery.data?.topics ?? [];
  const selectedTopic: TopicDiscoveryJSON | null =
    topics.find((t) => t.topic_id === selectedTopicId) ?? topics[0] ?? null;

  // 1~3단계 순차 실행 파이프라인
  const discoveryPipelineMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveCategoryId) {
        throw new Error('발굴할 trend_first 카테고리를 먼저 선택해 주세요.');
      }
      setBlockedKeywords([]);
      setPipelineFeedback(null);

      setPipelineStage('1/3 시드·Google Trends 수집 및 YMYL 2중 판정 중...');
      const step1 = await runStep1({
        category_id: effectiveCategoryId,
        content_type: 'explainer',
        extra_keywords: parseKeywords(extraKeywordsRaw),
        include_google_trends: includeTrends
      });
      setBlockedKeywords(step1.blocked_keywords);

      if (step1.topics.length === 0) {
        setPipelineStage(null);
        return {
          runId: step1.run_id,
          topicCount: 0,
          trendsStatus: step1.google_trends_status,
          searchadUsed: false,
          cacheHits: 0
        };
      }

      setPipelineStage('2/3 네이버 데이터랩 기준 키워드 정규화 배치 조회 중...');
      const step2 = await runStep2({ run_id: step1.run_id });

      setPipelineStage('3/3 네이버 블로그·뉴스 문서 공급량 및 선택형 검색광고 조회 중...');
      const step3 = await runStep3({ run_id: step1.run_id });

      setPipelineStage(null);
      return {
        runId: step1.run_id,
        topicCount: step3.topics.length,
        trendsStatus: step1.google_trends_status,
        searchadUsed: step3.searchad_used,
        cacheHits: step2.cache_hits
      };
    },
    onSuccess: (summary) => {
      void queryClient.invalidateQueries({ queryKey: ['topics'] });
      setPipelineFeedback({
        tone: summary.topicCount > 0 ? 'success' : 'warning',
        text:
          summary.topicCount > 0
            ? `1~3단계 발굴 완료 (${summary.topicCount}건, 데이터랩 캐시 ${summary.cacheHits}건, Trends: ${summary.trendsStatus}, 검색광고: ${summary.searchadUsed ? '연동' : '미설정 폴백'}). 아래에서 글감을 선택해 4단계 1차 출처를 확보하세요.`
            : '모든 후보 키워드가 YMYL 판정에서 차단되었습니다.'
      });
    },
    onError: (err) => {
      setPipelineStage(null);
      setPipelineFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '글감 발굴 파이프라인 실행에 실패했습니다.')
      });
    }
  });

  // CaptureAsset 기반 글감 생성
  const fromCaptureMutation = useMutation({
    mutationFn: (input: TopicFromCaptureRequest) => createFromCapture(input),
    onSuccess: (res) => {
      setCaptureBorderline(null);
      setCaptureKeyword('');
      setSelectedTopicId(res.topic.topic_id);
      setPipelineFeedback({
        tone: 'success',
        text: `캡처 기반 글감 "${res.topic.keyword}"을(를) 생성했습니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
    onError: (err, input) => {
      if (err instanceof ApiRequestError && err.code === 'YMYL_BORDERLINE_CONFIRM_REQUIRED') {
        setCaptureBorderline({ payload: input, reason: err.message });
        return;
      }
      setCaptureBorderline(null);
      setPipelineFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '캡처 기반 글감 생성에 실패했습니다.')
      });
    }
  });

  // YMYL 경계 사례 확인
  const ymylConfirmMutation = useMutation({
    mutationFn: (topicId: string) => confirmYmyl(topicId, { confirmed: true }),
    onSuccess: (res) => {
      setPipelineFeedback({
        tone: 'success',
        text: `글감 "${res.topic.keyword}"의 YMYL 경계 사례 확인을 완료했습니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
    onError: (err) => {
      setPipelineFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, 'YMYL 경계 사례 확인에 실패했습니다.')
      });
    }
  });

  // Step 4: 1차 출처 후보 조회
  const candidatesMutation = useMutation({
    mutationFn: (topicId: string) => loadSourceCandidates(topicId),
    onSuccess: (res) => {
      setCandidatesState({
        topicId: res.topic_id,
        allowedDomains: res.allowed_domains,
        candidates: res.candidates
      });
      setSourceFeedback(null);
    },
    onError: (err) => {
      setSourceFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '1차 출처 후보 조회에 실패했습니다.')
      });
    }
  });

  // Step 4: 1차 출처 스냅샷 저장
  const snapshotMutation = useMutation({
    mutationFn: ({ topicId, input }: { topicId: string; input: CreateSourceSnapshotRequest }) =>
      saveSourceSnapshot(topicId, input),
    onSuccess: (res) => {
      setUnlistedDomainConfirm(null);
      setManualSourceUrl('');
      setSourceFeedback({
        tone: 'success',
        text: `1차 출처 스냅샷(${res.snapshot.domain}, ${res.snapshot.char_count}자)을 R2에 저장했습니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
    onError: (err, variables) => {
      if (err instanceof ApiRequestError && err.code === 'SOURCE_DOMAIN_CONFIRM_REQUIRED') {
        setUnlistedDomainConfirm({
          topicId: variables.topicId,
          url: variables.input.url,
          reason: err.message
        });
        setSourceFeedback(null);
        return;
      }
      setUnlistedDomainConfirm(null);
      setSourceFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '1차 출처 스냅샷 저장에 실패했습니다.')
      });
    }
  });

  const handleManualSnapshotSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedTopic || !manualSourceUrl.trim()) return;
    snapshotMutation.mutate({
      topicId: selectedTopic.topic_id,
      input: {
        url: manualSourceUrl.trim(),
        ingest_channel: 'manual_input',
        confirm_unlisted_domain: false
      }
    });
  };

  return (
    <div className="flex flex-col gap-5 pb-6">
      {/* 1. trend_first 1~3단계 분할 발굴 */}
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-brand">글감 발굴 파이프라인 (1~3단계)</h2>
            <p className="mt-1 text-sm text-ink-soft">
              시드·Trends 수집 및 YMYL 2중 판정 → 데이터랩 정규화 배치 → 블로그·뉴스 공급량 수집을
              순차 실행합니다.
            </p>
          </div>
          <StatusBadge tone="neutral" icon="1-3" label="Workers 분할 요청" />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>트렌드 우선 카테고리 (trend_first)</span>
            <select
              value={effectiveCategoryId}
              onChange={(e) => setSelectedCategoryId(e.target.value)}
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            >
              {trendCategories.length === 0 ? (
                <option value="">등록된 trend_first 카테고리가 없습니다</option>
              ) : (
                trendCategories.map((cat) => (
                  <option key={cat.category_id} value={cat.category_id}>
                    {cat.display_name} (기준: {cat.datalab_anchor_keyword})
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>추가 탐색 키워드 (쉼표 구분, 선택)</span>
            <input
              type="text"
              value={extraKeywordsRaw}
              onChange={(e) => setExtraKeywordsRaw(e.target.value)}
              placeholder="예: Cloudflare D1, WebCrypto"
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={includeTrends}
              onChange={(e) => setIncludeTrends(e.target.checked)}
              className="h-4 w-4"
            />
            <span>Google Trends RSS 보조 시드 포함 (429 차단 시 자동 폴백)</span>
          </label>

          <button
            type="button"
            disabled={!effectiveCategoryId || discoveryPipelineMutation.isPending}
            onClick={() => discoveryPipelineMutation.mutate()}
            className="pill-btn bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:opacity-50"
          >
            {discoveryPipelineMutation.isPending ? '발굴 실행 중...' : '1~3단계 글감 발굴 실행'}
          </button>
        </div>

        {pipelineStage && (
          <p role="status" className="mt-3 rounded-lg bg-canvas px-3.5 py-2.5 text-sm text-brand">
            {pipelineStage}
          </p>
        )}

        {pipelineFeedback && (
          <p
            role={pipelineFeedback.tone === 'danger' ? 'alert' : 'status'}
            className={`mt-3 rounded-lg px-3.5 py-2.5 text-sm ${
              pipelineFeedback.tone === 'danger'
                ? 'bg-danger-bg text-danger'
                : pipelineFeedback.tone === 'warning'
                  ? 'bg-warning text-warning-ink'
                  : 'bg-success-bg text-brand'
            }`}
          >
            {pipelineFeedback.text}
          </p>
        )}

        {blockedKeywords.length > 0 && (
          <div className="mt-3 rounded-xl border border-danger/25 bg-danger-bg p-3.5 text-xs text-danger">
            <p className="font-semibold">YMYL 차단된 후보 키워드 ({blockedKeywords.length}건)</p>
            <ul className="mt-1.5 list-disc pl-5">
              {blockedKeywords.map((item) => (
                <li key={item.keyword}>
                  {item.keyword} ({item.stage}): {item.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* 2. 현장 캡처(CaptureAsset) 기반 글감 생성 */}
      <section className="card-surface p-6">
        <h3 className="text-lg font-semibold text-ink">현장 캡처로 글감 만들기 (후기 · 브이로그)</h3>
        <p className="mt-1 text-xs text-ink-soft">
          휴대폰에서 올린 실사 사진·메모(CaptureAsset)로 experience_review 또는 vlog 글감을
          생성합니다.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>캡처 자산 선택</span>
            <select
              value={effectiveCaptureId}
              onChange={(e) => setSelectedCaptureId(e.target.value)}
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            >
              {(capturesQuery.data?.captures ?? []).length === 0 ? (
                <option value="">업로드된 캡처 자산이 없습니다</option>
              ) : (
                (capturesQuery.data?.captures ?? []).map((cap) => (
                  <option key={cap.capture_id} value={cap.capture_id}>
                    [{cap.content_type}] {cap.field_memo.slice(0, 32) || cap.capture_id} (사진{' '}
                    {cap.photos.length}장)
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>글감 키워드 / 주제 (선택)</span>
            <input
              type="text"
              value={captureKeyword}
              onChange={(e) => setCaptureKeyword(e.target.value)}
              placeholder="비우면 현장 메모 첫 줄을 사용합니다"
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            disabled={!effectiveCaptureId || fromCaptureMutation.isPending}
            onClick={() =>
              fromCaptureMutation.mutate({
                capture_id: effectiveCaptureId,
                ...(captureKeyword.trim() ? { keyword: captureKeyword.trim() } : {})
              })
            }
            className="pill-btn border border-cta bg-surface px-5 text-sm font-semibold text-cta disabled:opacity-50"
          >
            {fromCaptureMutation.isPending ? '생성 중...' : '캡처로 글감 만들기'}
          </button>
        </div>

        {captureBorderline && (
          <div role="alert" className="mt-3 rounded-xl border border-warning bg-canvas p-4 text-sm">
            <StatusBadge tone="warning" icon="!" label="YMYL 경계 사례 확인 필요 (409)" />
            <p className="mt-2 text-ink">{captureBorderline.reason}</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() =>
                  fromCaptureMutation.mutate({
                    ...captureBorderline.payload,
                    confirm_borderline: true
                  })
                }
                className="pill-btn bg-cta px-5 text-sm font-semibold text-ink-inverse"
              >
                경계 사례 확인 후 글감 생성
              </button>
              <button
                type="button"
                onClick={() => setCaptureBorderline(null)}
                className="pill-btn border border-ink/20 bg-surface px-4 text-sm text-ink"
              >
                취소
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 3. 발굴된 글감 목록 + YMYL 경계 확인 */}
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-ink">내 글감 목록 ({topics.length}건)</h3>
          <button
            type="button"
            onClick={() => void topicsQuery.refetch()}
            className="pill-btn border border-ink/20 bg-surface px-4 text-sm font-medium text-ink"
          >
            새로고침
          </button>
        </div>

        {topics.length === 0 ? (
          <p className="mt-4 rounded-xl bg-surface-subtle p-4 text-sm text-ink-soft">
            아직 발굴된 글감이 없습니다. 위에서 1~3단계 발굴을 실행하거나 캡처로 글감을 만들어
            보세요.
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {topics.map((topic) => {
              const isSelected = selectedTopic?.topic_id === topic.topic_id;
              return (
                <article
                  key={topic.topic_id}
                  data-testid={`topic-row-${topic.topic_id}`}
                  className={`rounded-xl border p-4 ${
                    isSelected ? 'border-cta bg-success-bg/35' : 'border-ink/10 bg-surface-subtle'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-base font-semibold text-ink">{topic.keyword}</h4>
                        <StatusBadge tone="neutral" icon="•" label={topic.content_type} />
                        <StatusBadge
                          tone={topic.status === 'READY' ? 'success' : 'neutral'}
                          icon={topic.status === 'READY' ? '✓' : '…'}
                          label={topic.status}
                        />
                        <StatusBadge
                          tone={
                            topic.ymyl_status === 'BORDERLINE_PENDING'
                              ? 'warning'
                              : topic.ymyl_status === 'BLOCKED'
                                ? 'danger'
                                : 'success'
                          }
                          icon={topic.ymyl_status === 'BORDERLINE_PENDING' ? '!' : '✓'}
                          label={topic.ymyl_status}
                        />
                        {topic.sponsorship.is_sponsored && (
                          <StatusBadge tone="sponsored" icon="★" label="협찬" />
                        )}
                      </div>

                      <p className="mt-2 text-xs text-ink-soft">
                        수요 지수: {topic.datalab_demand_index ?? '-'} · 블로그 공급:{' '}
                        {topic.blog_supply_count ?? '-'} · 뉴스 공급:{' '}
                        {topic.news_supply_count ?? '-'}
                        {topic.monthly_search_volume !== null
                          ? ` · 월간 검색량: ${topic.monthly_search_volume} (경쟁도 ${topic.competition_score ?? '-'})`
                          : ''}
                        {' · '}1차 출처: {topic.sources.length}건
                      </p>

                      {topic.ymyl_status === 'BORDERLINE_PENDING' && topic.ymyl_reason && (
                        <p className="mt-1.5 text-xs font-medium text-ink">
                          경계 사유: {topic.ymyl_reason}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {topic.ymyl_status === 'BORDERLINE_PENDING' && (
                        <button
                          type="button"
                          disabled={ymylConfirmMutation.isPending}
                          onClick={() => ymylConfirmMutation.mutate(topic.topic_id)}
                          className="pill-btn bg-warning px-4 text-sm font-semibold text-warning-ink"
                        >
                          YMYL 경계 확인
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTopicId(topic.topic_id);
                          setUnlistedDomainConfirm(null);
                          setSourceFeedback(null);
                        }}
                        className="pill-btn border border-ink/20 bg-surface px-4 text-sm font-medium text-ink"
                      >
                        {topic.content_type === 'explainer' ? '4단계 출처 관리' : '선택'}
                      </button>

                      {onSelectTopicForManuscript && (
                        <button
                          type="button"
                          disabled={
                            topic.ymyl_status === 'BORDERLINE_PENDING' ||
                            topic.ymyl_status === 'BLOCKED' ||
                            (topic.content_type === 'explainer' && topic.sources.length === 0)
                          }
                          onClick={() => onSelectTopicForManuscript(topic.topic_id)}
                          className="pill-btn bg-cta px-4 text-sm font-semibold text-ink-inverse disabled:opacity-45"
                        >
                          원고 작성
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* 4. Step 4: 선택 글감의 1차 출처 후보 및 본문 스냅샷 저장 */}
      {selectedTopic && (
        <section className="card-surface p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-brand">
                4단계: 1차 출처 후보 &amp; 본문 스냅샷 ({selectedTopic.keyword})
              </h3>
              <p className="mt-1 text-xs text-ink-soft">
                공식 허용 도메인(go.kr, gov.kr, law.go.kr, ac.kr, or.kr, re.kr 및 카테고리 등록
                도메인)을 우선 제시하며, 본문은 HTMLRewriter 스트리밍 추출 후 최대 50KB로 R2에
                저장됩니다.
              </p>
            </div>
            <button
              type="button"
              disabled={candidatesMutation.isPending}
              onClick={() => candidatesMutation.mutate(selectedTopic.topic_id)}
              className="pill-btn border border-cta bg-surface px-4 text-sm font-semibold text-cta disabled:opacity-50"
            >
              {candidatesMutation.isPending ? '후보 검색 중...' : '1차 출처 후보 조회 (webkr)'}
            </button>
          </div>

          {candidatesState && candidatesState.topicId === selectedTopic.topic_id && (
            <div className="mt-4 flex flex-col gap-2 rounded-xl bg-surface-subtle p-4">
              <p className="text-xs text-ink-soft">
                허용 도메인: {candidatesState.allowedDomains.join(', ')}
              </p>
              {candidatesState.candidates.length === 0 ? (
                <p className="text-sm text-ink-soft">
                  웹문서 검색 결과 중 허용 도메인에 해당하는 후보가 없습니다. 아래에서 공식 출처
                  URL을 직접 입력할 수 있습니다.
                </p>
              ) : (
                candidatesState.candidates.map((cand) => (
                  <div
                    key={cand.url}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">{cand.title}</p>
                      <p className="break-all text-xs text-brand">{cand.url}</p>
                      {cand.description && (
                        <p className="mt-1 text-xs text-ink-soft">{cand.description}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={snapshotMutation.isPending}
                      onClick={() =>
                        snapshotMutation.mutate({
                          topicId: selectedTopic.topic_id,
                          input: {
                            url: cand.url,
                            ingest_channel: 'webkr_search',
                            confirm_unlisted_domain: false
                          }
                        })
                      }
                      className="pill-btn bg-cta px-4 text-sm font-semibold text-ink-inverse disabled:opacity-50"
                    >
                      스냅샷 저장
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* 직접 URL 입력 */}
          <form onSubmit={handleManualSnapshotSubmit} className="mt-4 flex flex-wrap gap-2">
            <input
              type="url"
              value={manualSourceUrl}
              onChange={(e) => setManualSourceUrl(e.target.value)}
              placeholder="1차 출처 URL 직접 입력 (예: https://www.msit.go.kr/...)"
              aria-label="1차 출처 직접 URL"
              className="min-h-[44px] min-w-[240px] flex-1 rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
            <button
              type="submit"
              disabled={!manualSourceUrl.trim() || snapshotMutation.isPending}
              className="pill-btn bg-cta px-5 text-sm font-semibold text-ink-inverse disabled:opacity-50"
            >
              {snapshotMutation.isPending ? '수집 중...' : '직접 URL 스냅샷 저장'}
            </button>
          </form>

          {unlistedDomainConfirm && unlistedDomainConfirm.topicId === selectedTopic.topic_id && (
            <div role="alert" className="mt-3 rounded-xl border border-warning bg-canvas p-4 text-sm">
              <StatusBadge tone="warning" icon="!" label="목록 외 도메인 경고 (409)" />
              <p className="mt-2 text-ink">{unlistedDomainConfirm.reason}</p>
              <p className="mt-1 break-all text-xs text-ink-soft">{unlistedDomainConfirm.url}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={snapshotMutation.isPending}
                  onClick={() =>
                    snapshotMutation.mutate({
                      topicId: unlistedDomainConfirm.topicId,
                      input: {
                        url: unlistedDomainConfirm.url,
                        ingest_channel: 'manual_input',
                        confirm_unlisted_domain: true
                      }
                    })
                  }
                  className="pill-btn bg-cta px-5 text-sm font-semibold text-ink-inverse"
                >
                  목록 외 도메인 확인 후 스냅샷 저장
                </button>
                <button
                  type="button"
                  onClick={() => setUnlistedDomainConfirm(null)}
                  className="pill-btn border border-ink/20 bg-surface px-4 text-sm text-ink"
                >
                  취소
                </button>
              </div>
            </div>
          )}

          {sourceFeedback && (
            <p
              role={sourceFeedback.tone === 'danger' ? 'alert' : 'status'}
              className={`mt-3 rounded-lg px-3.5 py-2.5 text-sm ${
                sourceFeedback.tone === 'danger'
                  ? 'bg-danger-bg text-danger'
                  : 'bg-success-bg text-brand'
              }`}
            >
              {sourceFeedback.text}
            </p>
          )}

          {selectedTopic.sources.length > 0 && (
            <div className="mt-4 rounded-xl bg-surface-subtle p-4">
              <p className="text-xs font-semibold text-ink">
                저장된 1차 출처 스냅샷 ({selectedTopic.sources.length}건)
              </p>
              <ul className="mt-2 flex flex-col gap-1.5 text-xs text-ink-soft">
                {selectedTopic.sources.map((src) => (
                  <li key={src.source_id} className="break-all">
                    <strong className="text-brand">{src.domain}</strong> · {src.url} ({src.ingest_channel})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
