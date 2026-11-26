import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  buildSequentialImageFilename,
  formatImageMarker,
  stripHtmlToPlainText,
  type ApproveManuscriptRequest,
  type CaptureResponse,
  type CapturesListResponse,
  type GenerateManuscriptRequest,
  type LlmConsentRequest,
  type ManuscriptDetailResponse,
  type ManuscriptResponse,
  type ManuscriptsListResponse,
  type NgramEvaluationResult,
  type NgramReferenceItem,
  type ResolveVerifyRequest,
  type TopicsListResponse,
  type UpdateManuscriptRequest,
  type VerifySanitizeResponse,
  type Visibility
} from '@content-desk/shared';
import {
  approveManuscript,
  consentCaptureLlm,
  fetchCaptures,
  fetchManuscriptDetail,
  fetchManuscripts,
  fetchTopics,
  generateManuscript,
  getApiErrorMessage,
  resolveVerifyClaim,
  updateManuscript,
  verifySanitizeManuscript
} from '../lib/api-client';
import { runNgramSimilarityCheck } from '../platform/ngram';
import { BottomActionBar } from '../components/BottomActionBar';
import { IsolatedPreview } from '../components/IsolatedPreview';
import { StatusBadge } from '../components/StatusBadge';
import { VerifyGate } from '../components/VerifyGate';

export interface ManuscriptPageProps {
  initialTopicId?: string | null;
  listTopics?: () => Promise<TopicsListResponse>;
  listCaptures?: () => Promise<CapturesListResponse>;
  listManuscripts?: () => Promise<ManuscriptsListResponse>;
  loadManuscriptDetail?: (id: string) => Promise<ManuscriptDetailResponse>;
  submitCaptureConsent?: (id: string, input: LlmConsentRequest) => Promise<CaptureResponse>;
  requestGenerate?: (input: GenerateManuscriptRequest) => Promise<ManuscriptResponse>;
  requestVerifySanitize?: (id: string) => Promise<VerifySanitizeResponse>;
  requestUpdate?: (id: string, input: UpdateManuscriptRequest) => Promise<ManuscriptResponse>;
  requestResolveVerify?: (id: string, input: ResolveVerifyRequest) => Promise<ManuscriptResponse>;
  requestApprove?: (id: string, input: ApproveManuscriptRequest) => Promise<ManuscriptResponse>;
  runNgram?: (
    manuscriptText: string,
    references: readonly NgramReferenceItem[]
  ) => Promise<NgramEvaluationResult>;
}

export function ManuscriptPage({
  initialTopicId = null,
  listTopics = () => fetchTopics(),
  listCaptures = () => fetchCaptures(),
  listManuscripts = () => fetchManuscripts(),
  loadManuscriptDetail = fetchManuscriptDetail,
  submitCaptureConsent = consentCaptureLlm,
  requestGenerate = generateManuscript,
  requestVerifySanitize = verifySanitizeManuscript,
  requestUpdate = updateManuscript,
  requestResolveVerify = resolveVerifyClaim,
  requestApprove = approveManuscript,
  runNgram = (text, refs) => runNgramSimilarityCheck(text, refs)
}: ManuscriptPageProps) {
  const queryClient = useQueryClient();

  const [selectedTopicId, setSelectedTopicId] = useState<string>(initialTopicId ?? '');
  const [selectedManuscriptId, setSelectedManuscriptId] = useState<string>('');
  const [llmConsentChecked, setLlmConsentChecked] = useState<boolean>(false);
  const [generationStage, setGenerationStage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null
  );

  // Edit form local state
  const [editTitle, setEditTitle] = useState<string>('');
  const [editBodyHtml, setEditBodyHtml] = useState<string>('');
  const [editBoardName, setEditBoardName] = useState<string>('');
  const [editTagsRaw, setEditTagsRaw] = useState<string>('');
  const [editVisibility, setEditVisibility] = useState<Visibility>('전체공개');
  const [syncedKey, setSyncedKey] = useState<string>('');

  // Browser Web Worker N-gram similarity state
  const [ngramResult, setNgramResult] = useState<NgramEvaluationResult | null>(null);
  const [isNgramLoading, setIsNgramLoading] = useState<boolean>(false);

  useEffect(() => {
    if (initialTopicId) {
      setSelectedTopicId(initialTopicId);
    }
  }, [initialTopicId]);

  const topicsQuery = useQuery({
    queryKey: ['topics'],
    queryFn: listTopics,
    retry: false
  });

  const capturesQuery = useQuery({
    queryKey: ['captures'],
    queryFn: listCaptures,
    retry: false
  });

  const manuscriptsQuery = useQuery({
    queryKey: ['manuscripts'],
    queryFn: listManuscripts,
    retry: false
  });

  const readyTopics = (topicsQuery.data?.topics ?? []).filter(
    (t) =>
      t.ymyl_status !== 'BLOCKED' &&
      t.ymyl_status !== 'BORDERLINE_PENDING' &&
      (t.content_type !== 'explainer' || t.sources.length > 0)
  );

  const effectiveTopicId = selectedTopicId || readyTopics[0]?.topic_id || '';
  const selectedTopic = readyTopics.find((t) => t.topic_id === effectiveTopicId) ?? null;

  const effectiveManuscriptId =
    selectedManuscriptId || manuscriptsQuery.data?.manuscripts[0]?.manuscript_id || '';

  const detailQuery = useQuery({
    queryKey: ['manuscript-detail', effectiveManuscriptId],
    queryFn: () => loadManuscriptDetail(effectiveManuscriptId),
    enabled: Boolean(effectiveManuscriptId),
    retry: false
  });

  const detail = detailQuery.data ?? null;

  // Sync edit form whenever manuscript version/hash changes
  useEffect(() => {
    if (!detail) return;
    const key = `${detail.manuscript.manuscript_id}:${detail.manuscript.version}:${detail.manuscript.content_hash}`;
    if (key === syncedKey) return;
    setEditTitle(detail.manuscript.selected_title);
    setEditBodyHtml(detail.manuscript.body_html);
    setEditBoardName(detail.manuscript.naver_board_name);
    setEditTagsRaw(detail.manuscript.tags.join(', '));
    setEditVisibility(detail.manuscript.visibility);
    setSyncedKey(key);
  }, [detail, syncedKey]);

  // Run browser Web Worker N-gram similarity check against past approved manuscripts + SERP snippets
  const ngramReferences = useMemo<NgramReferenceItem[]>(() => {
    if (!detail) return [];
    const pastRefs: NgramReferenceItem[] = detail.comparison_context.past_manuscripts.map((m) => ({
      id: `past-${m.manuscript_id}`,
      kind: 'past_manuscript',
      label: m.selected_title || m.manuscript_id,
      text: `${m.selected_title}\n${m.body_text}`
    }));
    const serpRefs: NgramReferenceItem[] = detail.comparison_context.serp_snippets.map((s) => ({
      id: s.id,
      kind: 'serp_snippet',
      label: s.label,
      text: s.text
    }));
    return [...pastRefs, ...serpRefs];
  }, [detail]);

  useEffect(() => {
    if (!detail) {
      setNgramResult(null);
      return;
    }
    let cancelled = false;
    setIsNgramLoading(true);
    const plainText = `${detail.manuscript.selected_title}\n${stripHtmlToPlainText(detail.manuscript.body_html)}`;
    void runNgram(plainText, ngramReferences)
      .then((res) => {
        if (!cancelled) {
          setNgramResult(res);
          setIsNgramLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsNgramLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [detail?.manuscript.manuscript_id, detail?.manuscript.content_hash, ngramReferences]);

  // Check capture LLM consent status for selected experience_review / vlog topic
  const linkedCapture = useMemo(() => {
    if (!selectedTopic || selectedTopic.capture_ids.length === 0) return null;
    const capId = selectedTopic.capture_ids[0];
    return (capturesQuery.data?.captures ?? []).find((c) => c.capture_id === capId) ?? null;
  }, [selectedTopic, capturesQuery.data]);

  const needsCaptureConsent =
    selectedTopic !== null &&
    selectedTopic.content_type !== 'explainer' &&
    linkedCapture !== null &&
    linkedCapture.llm_consent_at === null;

  // 2-request flow: LLM 전송 동의 확인 -> 생성(요청 1) -> 대조·정제(요청 2)
  const generateFlowMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTopic) {
        throw new Error('원고를 생성할 글감을 먼저 선택해 주세요.');
      }
      if (!llmConsentChecked) {
        throw new Error('무료 LLM 제공자 전송 안내를 확인하고 동의에 체크해 주세요.');
      }
      setFeedback(null);

      if (needsCaptureConsent && linkedCapture) {
        setGenerationStage('0/2 캡처 자산의 무료 LLM 전송 동의 기록 중...');
        await submitCaptureConsent(linkedCapture.capture_id, {
          acknowledged_free_tier_training: true
        });
        void queryClient.invalidateQueries({ queryKey: ['captures'] });
      }

      setGenerationStage('1/2 LLM 원고 초안 생성 요청 중...');
      const generated = await requestGenerate({
        topic_id: selectedTopic.topic_id
      });

      setGenerationStage('2/2 주장–출처 인용구 대조 및 서버 HTML 정제 요청 중...');
      const verified = await requestVerifySanitize(generated.manuscript.manuscript_id);

      setGenerationStage(null);
      return verified;
    },
    onSuccess: (res) => {
      setSelectedManuscriptId(res.manuscript.manuscript_id);
      setFeedback({
        tone: 'success',
        text: `원고 생성 및 대조·정제를 완료했습니다 (통과 ${res.verified_claim_count}건, [VERIFY] ${res.unresolved_verify_count}건).`
      });
      void queryClient.invalidateQueries({ queryKey: ['manuscripts'] });
      void queryClient.invalidateQueries({
        queryKey: ['manuscript-detail', res.manuscript.manuscript_id]
      });
    },
    onError: (err) => {
      setGenerationStage(null);
      setFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '원고 생성·대조 요청이 실패했습니다.')
      });
    }
  });

  const reverifyMutation = useMutation({
    mutationFn: (id: string) => requestVerifySanitize(id),
    onSuccess: (res) => {
      setFeedback({
        tone: 'success',
        text: `주장–출처 대조 및 HTML 정제를 다시 완료했습니다 ([VERIFY] ${res.unresolved_verify_count}건).`
      });
      void queryClient.invalidateQueries({ queryKey: ['manuscripts'] });
      void queryClient.invalidateQueries({
        queryKey: ['manuscript-detail', res.manuscript.manuscript_id]
      });
    },
    onError: (err) => {
      setFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '대조·정제 요청이 실패했습니다.')
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateManuscriptRequest }) =>
      requestUpdate(id, payload),
    onSuccess: (res) => {
      setFeedback({
        tone: 'success',
        text: `원고를 저장했습니다(v${res.manuscript.version}). 수정 시 기존 승인은 자동 해제됩니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['manuscripts'] });
      void queryClient.invalidateQueries({
        queryKey: ['manuscript-detail', res.manuscript.manuscript_id]
      });
    },
    onError: (err) => {
      setFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '원고 수정 저장에 실패했습니다.')
      });
    }
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ResolveVerifyRequest }) =>
      requestResolveVerify(id, input),
    onSuccess: (res) => {
      setFeedback({
        tone: 'success',
        text: `[VERIFY] 항목을 해소했습니다 (남은 미해소: ${res.unresolved_verify_count}건).`
      });
      void queryClient.invalidateQueries({ queryKey: ['manuscripts'] });
      void queryClient.invalidateQueries({
        queryKey: ['manuscript-detail', res.manuscript.manuscript_id]
      });
    },
    onError: (err) => {
      setFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '[VERIFY] 항목 해소에 실패했습니다.')
      });
    }
  });

  const approveMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ApproveManuscriptRequest }) =>
      requestApprove(id, input),
    onSuccess: (res) => {
      setFeedback({
        tone: 'success',
        text: `원고 "${res.manuscript.selected_title}"이(가) 승인되었습니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['manuscripts'] });
      void queryClient.invalidateQueries({
        queryKey: ['manuscript-detail', res.manuscript.manuscript_id]
      });
    },
    onError: (err) => {
      setFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '원고 승인에 실패했습니다.')
      });
    }
  });

  const allowedPreviewUrls = useMemo(() => {
    if (!detail) return [];
    const urls = new Set<string>();
    for (const s of detail.comparison_context.sources) urls.add(s.url);
    for (const c of detail.manuscript.claims) {
      if (c.resolution_url) urls.add(c.resolution_url);
    }
    return [...urls];
  }, [detail]);

  return (
    <div className="flex flex-col gap-5 pb-6">
      {/* 1. 원고 생성 (LLM 전송 동의 -> 요청 1 생성 -> 요청 2 대조/정제) */}
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-brand">원고 생성 · 대조 · 편집</h2>
            <p className="mt-1 text-sm text-ink-soft">
              글감을 선택하고 무료 LLM 전송 동의를 확인한 뒤, 생성(요청 1)과 주장 대조·HTML
              정제(요청 2)를 실행합니다.
            </p>
          </div>
          <StatusBadge tone="neutral" icon="2-REQ" label="생성 + 대조/정제" />
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>원고 작성 대상 글감 (READY)</span>
            <select
              value={effectiveTopicId}
              onChange={(e) => setSelectedTopicId(e.target.value)}
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            >
              {readyTopics.length === 0 ? (
                <option value="">생성 가능한 글감이 없습니다 (글감 발굴에서 출처를 확보하세요)</option>
              ) : (
                readyTopics.map((topic) => (
                  <option key={topic.topic_id} value={topic.topic_id}>
                    [{topic.content_type}] {topic.keyword} (출처 {topic.sources.length}건)
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-xl border border-ink/15 bg-surface-subtle p-3.5 text-sm text-ink">
            <input
              type="checkbox"
              checked={llmConsentChecked}
              onChange={(e) => setLlmConsentChecked(e.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              무료 티어 LLM(Gemini 2.5 Flash) 입력이 제공자 서비스 개선에 활용될 수 있음을
              확인했으며, 선택한 글감의 출처 발췌(최대 5KB) 또는 메모·사진 설명 텍스트 전송에
              동의합니다.
            </span>
          </label>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-soft">
              {needsCaptureConsent
                ? '선택한 캡처 자산의 LLM 전송 동의도 함께 기록됩니다.'
                : '원본 사진 파일은 LLM으로 전송되지 않습니다.'}
            </span>
            <button
              type="button"
              disabled={!selectedTopic || !llmConsentChecked || generateFlowMutation.isPending}
              onClick={() => generateFlowMutation.mutate()}
              className="pill-btn bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:opacity-45"
            >
              {generateFlowMutation.isPending
                ? '생성·대조 실행 중...'
                : '원고 생성 → 대조·정제 실행'}
            </button>
          </div>
        </div>

        {generationStage && (
          <p role="status" className="mt-3 rounded-lg bg-canvas px-3.5 py-2.5 text-sm text-brand">
            {generationStage}
          </p>
        )}

        {feedback && (
          <p
            role={feedback.tone === 'danger' ? 'alert' : 'status'}
            className={`mt-3 rounded-lg px-3.5 py-2.5 text-sm ${
              feedback.tone === 'danger'
                ? 'bg-danger-bg text-danger'
                : 'bg-success-bg text-brand'
            }`}
          >
            {feedback.text}
          </p>
        )}
      </section>

      {/* 2. 원고 목록 선택 */}
      <section className="card-surface p-6">
        <h3 className="text-lg font-semibold text-ink">
          내 원고 목록 ({manuscriptsQuery.data?.manuscripts.length ?? 0}건)
        </h3>
        {(manuscriptsQuery.data?.manuscripts ?? []).length === 0 ? (
          <p className="mt-3 rounded-xl bg-surface-subtle p-4 text-sm text-ink-soft">
            생성된 원고가 없습니다. 위에서 첫 원고를 생성해 보세요.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {(manuscriptsQuery.data?.manuscripts ?? []).map((ms) => {
              const active = ms.manuscript_id === effectiveManuscriptId;
              const approved = ms.approved_hash === ms.content_hash && ms.approved_hash !== null;
              return (
                <button
                  key={ms.manuscript_id}
                  type="button"
                  onClick={() => setSelectedManuscriptId(ms.manuscript_id)}
                  className={`pill-btn border px-4 text-left text-sm font-medium ${
                    active
                      ? 'border-cta bg-success-bg text-brand'
                      : 'border-ink/15 bg-surface-subtle text-ink'
                  }`}
                >
                  {ms.selected_title} (v{ms.version} · {approved ? '승인됨' : `VERIFY ${ms.unresolved_verify_count}`})
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 3. 선택 원고 편집 · 사진 메타데이터 · 격리 미리보기 · 검증 게이트 */}
      {detail && (
        <>
          <section className="card-surface p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-lg font-semibold text-ink">원고 편집 (v{detail.manuscript.version})</h3>
                <p className="mt-0.5 text-xs text-ink-soft">
                  내용을 수정·저장하면 content_hash가 갱신되고 기존 승인이 자동으로 해제됩니다.
                </p>
              </div>
              <button
                type="button"
                disabled={reverifyMutation.isPending}
                onClick={() => reverifyMutation.mutate(detail.manuscript.manuscript_id)}
                className="pill-btn border border-cta bg-surface px-4 text-sm font-semibold text-cta disabled:opacity-50"
              >
                {reverifyMutation.isPending ? '대조 중...' : '대조·정제 다시 실행'}
              </button>
            </div>

            {detail.manuscript.title_candidates.length > 1 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-ink-soft">제목 후보 선택</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {detail.manuscript.title_candidates.map((cand) => (
                    <button
                      key={cand}
                      type="button"
                      onClick={() => setEditTitle(cand)}
                      className={`pill-btn border px-3.5 text-xs font-medium ${
                        editTitle === cand
                          ? 'border-cta bg-success-bg text-brand'
                          : 'border-ink/15 bg-surface-subtle text-ink'
                      }`}
                    >
                      {cand}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                <span>선택한 제목</span>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                  <span>네이버 게시판명</span>
                  <input
                    type="text"
                    value={editBoardName}
                    onChange={(e) => setEditBoardName(e.target.value)}
                    className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
                  />
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                  <span>공개 범위</span>
                  <select
                    value={editVisibility}
                    onChange={(e) => setEditVisibility(e.target.value as Visibility)}
                    className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
                  >
                    <option value="전체공개">전체공개</option>
                    <option value="이웃공개">이웃공개</option>
                  </select>
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                  <span>추천 태그 (쉼표 구분)</span>
                  <input
                    type="text"
                    value={editTagsRaw}
                    onChange={(e) => setEditTagsRaw(e.target.value)}
                    className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                <span>본문 HTML (허용 태그만 저장 시 자동 정제)</span>
                <textarea
                  rows={8}
                  value={editBodyHtml}
                  onChange={(e) => setEditBodyHtml(e.target.value)}
                  className="rounded-lg border border-ink/20 bg-surface p-3.5 font-mono text-sm text-ink focus:border-cta focus:outline-none"
                />
              </label>
            </div>
          </section>

          {/* Phase 3 사진 메타데이터 섹션 (실제 썸네일/download-urls는 Phase 4) */}
          {(detail.manuscript.images.length > 0 || detail.comparison_context.capture_memo) && (
            <section className="card-surface p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-lg font-semibold text-ink">첨부 사진 마커 &amp; 캡처 메타데이터</h3>
                <StatusBadge tone="neutral" icon="📷" label="사진 썸네일은 Phase 4 연결" />
              </div>

              {detail.comparison_context.capture_memo && (
                <div className="mt-3 rounded-xl bg-surface-subtle p-3.5 text-xs text-ink-soft">
                  <p className="font-semibold text-ink">현장 메모</p>
                  <p className="mt-1 whitespace-pre-wrap">{detail.comparison_context.capture_memo}</p>
                </div>
              )}

              {detail.manuscript.images.length > 0 && (
                <ul className="mt-3 flex flex-col gap-2">
                  {detail.manuscript.images.map((img) => {
                    const meta = detail.comparison_context.capture_photos.find(
                      (p) => p.r2_key === img.r2_key
                    );
                    return (
                      <li
                        key={`${img.seq}-${img.r2_key}`}
                        className="rounded-xl border border-ink/10 bg-surface-subtle p-3.5 text-xs"
                      >
                        <p className="font-semibold text-brand">
                          {formatImageMarker(img.seq, img.caption)}
                        </p>
                        <p className="mt-1 text-ink">
                          내보내기 파일명: <code>{buildSequentialImageFilename(img.seq, img.caption)}</code>
                        </p>
                        {meta && (
                          <p className="mt-0.5 text-ink-soft">
                            규격: {meta.width}×{meta.height} · {meta.mime_type} ·{' '}
                            {Math.round(meta.byte_size / 1024)}KB
                            {meta.taken_at ? ` · 촬영: ${meta.taken_at}` : ''}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {/* 격리 미리보기 (<iframe sandbox="" srcDoc>) */}
          <IsolatedPreview
            title={editTitle || detail.manuscript.selected_title}
            bodyHtml={editBodyHtml || detail.manuscript.body_html}
            allowedSourceUrls={allowedPreviewUrls}
            ftcDisclosure={detail.manuscript.ftc_disclosure}
            aiDisclosure={detail.manuscript.ai_disclosure}
          />

          {/* 검증 게이트 */}
          <VerifyGate
            manuscript={detail.manuscript}
            unresolvedVerifyCount={detail.unresolved_verify_count}
            sources={detail.comparison_context.sources}
            ngramResult={ngramResult}
            isNgramLoading={isNgramLoading}
            isResolving={resolveMutation.isPending}
            isApproving={approveMutation.isPending}
            onResolveClaim={(input) =>
              resolveMutation.mutate({ id: detail.manuscript.manuscript_id, input })
            }
            onApprove={() =>
              approveMutation.mutate({
                id: detail.manuscript.manuscript_id,
                input: {
                  content_hash: detail.manuscript.content_hash,
                  ngram_max_similarity: ngramResult?.maxSimilarity ?? null
                }
              })
            }
          />

          <BottomActionBar ariaLabel="원고 저장 작업 바">
            <span className="text-xs text-ink-soft">
              편집 후 저장하면 승인이 초기화되며, 검증 게이트 통과 후 승인할 수 있습니다.
            </span>
            <button
              type="button"
              disabled={updateMutation.isPending}
              onClick={() =>
                updateMutation.mutate({
                  id: detail.manuscript.manuscript_id,
                  payload: {
                    selected_title: editTitle.trim(),
                    body_html: editBodyHtml,
                    naver_board_name: editBoardName.trim(),
                    visibility: editVisibility,
                    tags: editTagsRaw
                      .split(',')
                      .map((t) => t.trim())
                      .filter((t) => t.length > 0),
                    ngram_max_similarity: ngramResult?.maxSimilarity ?? null
                  }
                })
              }
              className="pill-btn bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:opacity-50"
            >
              {updateMutation.isPending ? '저장 중...' : '원고 수정 저장'}
            </button>
          </BottomActionBar>
        </>
      )}
    </div>
  );
}
