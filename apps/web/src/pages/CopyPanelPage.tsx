import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  buildNaverBlogWriteUrl,
  formatImageMarker,
  isManuscriptApprovedForExport,
  type ManuscriptDetailResponse,
  type ManuscriptsListResponse,
  type MediaDownloadUrlsRequest,
  type MediaDownloadUrlsResponse,
  type SettingsResponse
} from '@content-desk/shared';
import {
  fetchManuscriptDetail,
  fetchManuscripts,
  fetchSettings,
  getApiErrorMessage,
  requestMediaDownloadUrls
} from '../lib/api-client';
import {
  buildNaverCopyPayload,
  copyPlainTextToClipboard,
  copyRichManuscriptToClipboard,
  isRichClipboardSupported
} from '../platform/clipboard';
import {
  canWebShareFiles,
  copySingleImageAsPngToClipboard,
  exportPreparedImages,
  prepareShareImagesFromDownloadUrls,
  triggerSingleFileDownload,
  type PreparedShareImage
} from '../platform/share';
import { StatusBadge } from '../components/StatusBadge';

export interface CopyPanelPageProps {
  initialManuscriptId?: string | null;
  listManuscripts?: () => Promise<ManuscriptsListResponse>;
  loadManuscriptDetail?: (id: string) => Promise<ManuscriptDetailResponse>;
  loadSettings?: () => Promise<SettingsResponse>;
  loadDownloadUrls?: (input: MediaDownloadUrlsRequest) => Promise<MediaDownloadUrlsResponse>;
  prepareImages?: typeof prepareShareImagesFromDownloadUrls;
  copyRich?: typeof copyRichManuscriptToClipboard;
  copyPlain?: typeof copyPlainTextToClipboard;
  exportImages?: typeof exportPreparedImages;
  copyImagePng?: typeof copySingleImageAsPngToClipboard;
  onNavigateToManuscript?: (manuscriptId: string) => void;
  onNavigateToPublish?: (manuscriptId: string) => void;
}

export function CopyPanelPage({
  initialManuscriptId = null,
  listManuscripts = () => fetchManuscripts(),
  loadManuscriptDetail = fetchManuscriptDetail,
  loadSettings = fetchSettings,
  loadDownloadUrls = requestMediaDownloadUrls,
  prepareImages = prepareShareImagesFromDownloadUrls,
  copyRich = copyRichManuscriptToClipboard,
  copyPlain = copyPlainTextToClipboard,
  exportImages = exportPreparedImages,
  copyImagePng = copySingleImageAsPngToClipboard,
  onNavigateToManuscript,
  onNavigateToPublish
}: CopyPanelPageProps) {
  const [selectedManuscriptId, setSelectedManuscriptId] = useState<string>(
    initialManuscriptId ?? ''
  );
  const [preparedImages, setPreparedImages] = useState<PreparedShareImage[]>([]);
  const [isPreparingImages, setIsPreparingImages] = useState<boolean>(false);
  const [imagePrepError, setImagePrepError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null
  );
  const prepRequestIdRef = useRef(0);

  useEffect(() => {
    if (initialManuscriptId) {
      setSelectedManuscriptId(initialManuscriptId);
    }
  }, [initialManuscriptId]);

  const manuscriptsQuery = useQuery({
    queryKey: ['manuscripts'],
    queryFn: listManuscripts,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true
  });

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: loadSettings,
    retry: false
  });

  const effectiveManuscriptId =
    selectedManuscriptId || manuscriptsQuery.data?.manuscripts[0]?.manuscript_id || '';

  const detailQuery = useQuery({
    queryKey: ['manuscript-detail', effectiveManuscriptId],
    queryFn: () => loadManuscriptDetail(effectiveManuscriptId),
    enabled: Boolean(effectiveManuscriptId),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true
  });

  // 탭/창 포커스 복귀 시 서버에서 최신 원고 상태를 즉시 재조회해 Verified 복사 게이트 재판정
  const { refetch: refetchDetail } = detailQuery;
  useEffect(() => {
    if (!effectiveManuscriptId || typeof window === 'undefined') return;
    const handleFocus = () => {
      void refetchDetail();
    };
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refetchDetail();
      }
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [effectiveManuscriptId, refetchDetail]);

  const detail = detailQuery.data ?? null;

  const isApproved = detail
    ? isManuscriptApprovedForExport(detail.manuscript, detail.unresolved_verify_count)
    : false;

  const allowedSourceUrls = useMemo(() => {
    if (!detail) return [];
    const urls = new Set<string>();
    for (const s of detail.comparison_context.sources) urls.add(s.url);
    for (const c of detail.manuscript.claims) {
      if (c.resolution_url) urls.add(c.resolution_url);
    }
    return [...urls];
  }, [detail]);

  const copyPayload = useMemo(() => {
    if (!detail) return null;
    return buildNaverCopyPayload({
      bodyHtml: detail.manuscript.body_html,
      allowedSourceUrls,
      ftcDisclosure: detail.manuscript.ftc_disclosure,
      aiDisclosure: detail.manuscript.ai_disclosure,
      images: detail.manuscript.images
    });
  }, [detail, allowedSourceUrls]);

  const imageSignature = useMemo(
    () =>
      (detail?.manuscript.images ?? [])
        .map((img) => `${img.seq}:${img.r2_key}:${img.caption}`)
        .join('|'),
    [detail?.manuscript.images]
  );

  // 패널 진입·원고 전환 시 즉시 이전 준비 이미지를 비우고 요청 세대 가드로 덮어쓰기 차단
  useEffect(() => {
    const reqId = ++prepRequestIdRef.current;
    setPreparedImages([]);
    setImagePrepError(null);

    if (
      !detail ||
      detail.manuscript.manuscript_id !== effectiveManuscriptId ||
      !isApproved ||
      detail.manuscript.images.length === 0
    ) {
      setIsPreparingImages(false);
      return;
    }

    let cancelled = false;
    setIsPreparingImages(true);

    void loadDownloadUrls({ manuscript_id: detail.manuscript.manuscript_id })
      .then((res) => prepareImages(res.items))
      .then((items) => {
        if (!cancelled && prepRequestIdRef.current === reqId) {
          setPreparedImages(items);
          setIsPreparingImages(false);
        }
      })
      .catch((err) => {
        if (!cancelled && prepRequestIdRef.current === reqId) {
          setPreparedImages([]);
          setImagePrepError(getApiErrorMessage(err, '이미지 다운로드 URL 준비에 실패했습니다.'));
          setIsPreparingImages(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    effectiveManuscriptId,
    detail?.manuscript.manuscript_id,
    detail?.manuscript.content_hash,
    isApproved,
    imageSignature
  ]);

  const readyJpegFiles = useMemo(
    () => preparedImages.map((i) => i.jpegFile).filter((f): f is File => f !== null),
    [preparedImages]
  );

  const webShareAvailable = canWebShareFiles(readyJpegFiles);
  const richCopyAvailable = isRichClipboardSupported();
  const naverWriteUrl = buildNaverBlogWriteUrl(settingsQuery.data?.naver_blog_id ?? null);

  const gate = detail
    ? {
        manuscript: detail.manuscript,
        unresolvedVerifyCount: detail.unresolved_verify_count
      }
    : null;

  const handleCopyTitle = () => {
    if (!detail || !gate || !isApproved) return;
    setFeedback(null);
    void copyPlain(detail.manuscript.selected_title, gate)
      .then(() => {
        setFeedback({
          tone: 'success',
          text: `제목을 클립보드에 복사했습니다 (권장 게시판: ${detail.manuscript.naver_board_name} · ${detail.manuscript.visibility}).`
        });
      })
      .catch((err) => {
        setFeedback({ tone: 'danger', text: getApiErrorMessage(err, '제목 복사에 실패했습니다.') });
      });
  };

  const handleCopyRichBody = () => {
    if (!detail || !gate || !isApproved) return;
    setFeedback(null);
    // 클릭 핸들러 안에서 사전 await 없이 동기적으로 copyRich 호출
    void copyRich(
      {
        bodyHtml: detail.manuscript.body_html,
        allowedSourceUrls,
        ftcDisclosure: detail.manuscript.ftc_disclosure,
        aiDisclosure: detail.manuscript.ai_disclosure,
        images: detail.manuscript.images
      },
      gate
    )
      .then((res) => {
        setFeedback({
          tone: 'success',
          text:
            res.mode === 'rich'
              ? '서식 유지 본문(HTML + 일반 텍스트, 공시·이미지 마커 포함)을 복사했습니다.'
              : '브라우저 제한으로 일반 텍스트 본문(공시·이미지 마커 포함)으로 폴백 복사했습니다.'
        });
      })
      .catch((err) => {
        setFeedback({ tone: 'danger', text: getApiErrorMessage(err, '본문 복사에 실패했습니다.') });
      });
  };

  const handleCopyPlainBody = () => {
    if (!detail || !gate || !isApproved || !copyPayload) return;
    setFeedback(null);
    void copyPlain(copyPayload.plainText, gate)
      .then(() => {
        setFeedback({
          tone: 'success',
          text: '일반 텍스트 본문(공시·이미지 마커 포함)을 복사했습니다.'
        });
      })
      .catch((err) => {
        setFeedback({
          tone: 'danger',
          text: getApiErrorMessage(err, '일반 텍스트 복사에 실패했습니다.')
        });
      });
  };

  const handleCopyTags = () => {
    if (!detail || !gate || !isApproved) return;
    setFeedback(null);
    const tagText = detail.manuscript.tags
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
      .join(' ');
    void copyPlain(tagText, gate)
      .then(() => {
        setFeedback({
          tone: 'success',
          text: `추천 태그 ${detail.manuscript.tags.length}개를 클립보드에 복사했습니다.`
        });
      })
      .catch((err) => {
        setFeedback({ tone: 'danger', text: getApiErrorMessage(err, '태그 복사에 실패했습니다.') });
      });
  };

  const handleExportImages = () => {
    if (!detail || !gate || !isApproved || isPreparingImages) return;
    setFeedback(null);
    // 준비 완료된 File[]을 클릭 핸들러에서 즉시 navigator.share 또는 순차 다운로드 호출
    void exportImages(preparedImages, gate, {
      title: detail.manuscript.selected_title
    })
      .then((res) => {
        setFeedback({
          tone: 'success',
          text:
            res.mode === 'web_share'
              ? `이미지 ${res.count}장을 Web Share로 공유했습니다.`
              : `이미지 ${res.count}장의 순차 다운로드를 요청했습니다. 브라우저 정책으로 일부만 저장되면 아래 개별 사진 버튼을 이용해 주세요.`
        });
      })
      .catch((err) => {
        setFeedback({
          tone: 'danger',
          text: getApiErrorMessage(err, '이미지 내보내기에 실패했습니다.')
        });
      });
  };

  const handleCopySinglePng = (img: PreparedShareImage) => {
    if (!gate || !isApproved || isPreparingImages) return;
    setFeedback(null);
    void copyImagePng(img, gate)
      .then(() => {
        setFeedback({
          tone: 'success',
          text: `${img.filename} 이미지를 PNG 형식으로 클립보드에 복사했습니다. 스마트에디터 ONE에서 Ctrl+V로 붙여넣으세요.`
        });
      })
      .catch((err) => {
        setFeedback({
          tone: 'danger',
          text: getApiErrorMessage(err, '이미지 PNG 복사에 실패했습니다.')
        });
      });
  };

  const lockReason = detail
    ? detail.unresolved_verify_count > 0
      ? `미해소 [VERIFY] 항목이 ${detail.unresolved_verify_count}건 남아 있어 복사·공유가 잠겨 있습니다.`
      : detail.manuscript.approved_hash === null
        ? '아직 검증 게이트 승인이 완료되지 않아 복사·공유가 잠겨 있습니다.'
        : detail.manuscript.approved_hash !== detail.manuscript.content_hash
          ? '승인 후 원고가 수정되어 승인이 해제되었습니다. 검증 화면에서 다시 승인해 주세요.'
          : null
    : null;

  return (
    <div className="flex flex-col gap-5">
      {/* 1. 원고 선택 및 요약 */}
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-brand">수동 복사 · 이미지 공유 패널</h2>
            <p className="mt-1 text-sm text-ink-soft">
              갤럭시 탭 분할 화면과 PC 브라우저 공통 발행 경로입니다. 검증 게이트를 통과한 최신 승인
              원고만 복사·내보내기할 수 있습니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              tone={richCopyAvailable ? 'success' : 'neutral'}
              icon={richCopyAvailable ? '✓' : '•'}
              label={richCopyAvailable ? '서식 복사 지원' : '텍스트 복사 폴백'}
            />
            <StatusBadge
              tone={webShareAvailable ? 'success' : 'neutral'}
              icon={webShareAvailable ? '✓' : '↓'}
              label={webShareAvailable ? '다중 공유 지원' : '순차 JPEG 다운로드'}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>발행할 원고 선택</span>
            <select
              aria-label="발행할 원고 선택"
              value={effectiveManuscriptId}
              onChange={(e) => setSelectedManuscriptId(e.target.value)}
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            >
              {(manuscriptsQuery.data?.manuscripts ?? []).length === 0 ? (
                <option value="">생성된 원고가 없습니다</option>
              ) : (
                (manuscriptsQuery.data?.manuscripts ?? []).map((ms) => {
                  const ok = isManuscriptApprovedForExport(ms, ms.unresolved_verify_count);
                  return (
                    <option key={ms.manuscript_id} value={ms.manuscript_id}>
                      [{ok ? '승인됨' : '미승인/잠금'}] {ms.selected_title} (v{ms.version})
                    </option>
                  );
                })
              )}
            </select>
          </label>
        </div>

        {feedback && (
          <p
            role={feedback.tone === 'danger' ? 'alert' : 'status'}
            className={`mt-4 rounded-lg px-4 py-3 text-sm font-medium ${
              feedback.tone === 'danger'
                ? 'bg-danger-bg text-danger'
                : 'bg-success-bg text-brand'
            }`}
          >
            {feedback.text}
          </p>
        )}
      </section>

      {detail && (
        <>
          {/* Verified 복사 게이트 잠금 배너 */}
          {!isApproved && (
            <section
              data-testid="copy-gate-locked"
              role="alert"
              className="card-surface border-2 border-warning bg-canvas p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <StatusBadge tone="warning" icon="!" label="Verified 복사 게이트 잠금" />
                  <p className="mt-2 text-sm font-semibold text-ink">{lockReason}</p>
                  <p className="mt-1 text-xs text-ink-soft">
                    원고 편집·검증 화면에서 [VERIFY] 항목을 모두 해소하고 현재 버전을 승인해야
                    복사·이미지 내보내기 버튼이 열립니다.
                  </p>
                </div>
                {onNavigateToManuscript && (
                  <button
                    type="button"
                    onClick={() => onNavigateToManuscript(detail.manuscript.manuscript_id)}
                    className="pill-btn min-h-[48px] bg-cta px-6 text-sm font-semibold text-ink-inverse"
                  >
                    검증 화면으로 이동
                  </button>
                )}
              </div>
            </section>
          )}

          {/* 2. 권장 게시판 · 공개 범위 · 공시 안내 */}
          <section className="card-surface p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg font-semibold text-ink">{detail.manuscript.selected_title}</h3>
              <div className="flex flex-wrap items-center gap-2">
                {detail.manuscript.sponsorship.is_sponsored && (
                  <StatusBadge tone="sponsored" icon="★" label="협찬 · 공정위 공시 포함" />
                )}
                <StatusBadge
                  tone={isApproved ? 'success' : 'warning'}
                  icon={isApproved ? '✓' : '!'}
                  label={isApproved ? '승인 완료 · 복사 가능' : '승인 필요 · 복사 잠금'}
                />
              </div>
            </div>

            <dl className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-surface-subtle p-3.5">
                <dt className="text-xs text-ink-soft">권장 네이버 게시판</dt>
                <dd className="mt-1 text-sm font-semibold text-brand">
                  {detail.manuscript.naver_board_name}
                </dd>
              </div>
              <div className="rounded-lg bg-surface-subtle p-3.5">
                <dt className="text-xs text-ink-soft">권장 공개 범위</dt>
                <dd className="mt-1 text-sm font-semibold text-ink">
                  {detail.manuscript.visibility}
                </dd>
              </div>
              <div className="rounded-lg bg-surface-subtle p-3.5">
                <dt className="text-xs text-ink-soft">첨부 이미지 / 태그</dt>
                <dd className="mt-1 text-sm font-semibold text-ink">
                  사진 {detail.manuscript.images.length}장 · 태그 {detail.manuscript.tags.length}개
                </dd>
              </div>
            </dl>

            {/* 갤럭시 탭 분할 화면 최적화 48px+ 복사 버튼 묶음 */}
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={!isApproved}
                onClick={handleCopyTitle}
                className="pill-btn min-h-[48px] border border-cta bg-surface px-5 text-sm font-semibold text-cta disabled:cursor-not-allowed disabled:opacity-45"
              >
                제목 복사
              </button>

              <button
                type="button"
                disabled={!isApproved}
                onClick={handleCopyRichBody}
                className="pill-btn min-h-[48px] bg-cta px-5 text-sm font-semibold text-ink-inverse disabled:cursor-not-allowed disabled:opacity-45"
              >
                서식 유지 본문 복사
              </button>

              <button
                type="button"
                disabled={!isApproved}
                onClick={handleCopyPlainBody}
                className="pill-btn min-h-[48px] border border-ink/25 bg-surface px-5 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-45"
              >
                일반 텍스트 본문 복사
              </button>

              <button
                type="button"
                disabled={!isApproved || detail.manuscript.tags.length === 0}
                onClick={handleCopyTags}
                className="pill-btn min-h-[48px] border border-cta bg-surface px-5 text-sm font-semibold text-cta disabled:cursor-not-allowed disabled:opacity-45"
              >
                태그 일괄 복사 ({detail.manuscript.tags.length}개)
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-ink/10 pt-4">
              <a
                href={naverWriteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="pill-btn inline-flex min-h-[48px] items-center justify-center bg-band px-6 text-sm font-semibold text-ink-inverse"
              >
                네이버 블로그 글쓰기 열기
              </a>
              <span className="break-all text-xs text-ink-soft">
                이동 주소: <code>{naverWriteUrl}</code>
              </span>

              {onNavigateToPublish && isApproved && (
                <button
                  type="button"
                  onClick={() => onNavigateToPublish(detail.manuscript.manuscript_id)}
                  className="pill-btn ml-auto min-h-[48px] border border-cta bg-surface px-5 text-sm font-semibold text-cta"
                >
                  발행 URL(logNo) 등록하기
                </button>
              )}
            </div>
          </section>

          {/* 3. 이미지 내보내기 (사전 JPEG 변환 + Web Share / 순차 다운로드 / PC PNG 복사) */}
          <section className="card-surface p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-ink">
                  이미지 내보내기 ({detail.manuscript.images.length}장)
                </h3>
                <p className="mt-0.5 text-xs text-ink-soft">
                  패널 진입 시 WebP→JPEG 변환과 순번 파일명(01_캡션.jpg)을 미리 준비해 클릭 즉시
                  공유·다운로드합니다.
                </p>
              </div>
              <button
                type="button"
                disabled={!isApproved || isPreparingImages || readyJpegFiles.length === 0}
                onClick={handleExportImages}
                className="pill-btn min-h-[48px] bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isPreparingImages
                  ? 'JPEG 변환 준비 중...'
                  : webShareAvailable
                    ? `이미지 ${readyJpegFiles.length}장 한 번에 공유`
                    : `이미지 ${readyJpegFiles.length}장 순차 JPEG 다운로드`}
              </button>
            </div>

            {imagePrepError && (
              <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3.5 py-2.5 text-xs text-danger">
                {imagePrepError}
              </p>
            )}

            {detail.manuscript.images.length === 0 ? (
              <p className="mt-3 rounded-xl bg-surface-subtle p-4 text-sm text-ink-soft">
                이 원고에는 첨부된 이미지가 없습니다.
              </p>
            ) : (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {detail.manuscript.images.map((img) => {
                  const prep = preparedImages.find(
                    (p) => p.seq === img.seq && p.r2Key === img.r2_key
                  );
                  return (
                    <li
                      key={`${img.seq}-${img.r2_key}`}
                      className="flex flex-col gap-2.5 rounded-xl border border-ink/10 bg-surface-subtle p-3.5"
                    >
                      {prep?.downloadUrl && (
                        <img
                          src={prep.downloadUrl}
                          alt={img.caption}
                          loading="lazy"
                          className="h-36 w-full rounded-lg bg-canvas object-cover"
                        />
                      )}
                      <div className="text-xs">
                        <p className="font-semibold text-brand">
                          {formatImageMarker(img.seq, img.caption)}
                        </p>
                        <p className="mt-0.5 text-ink">
                          파일명: <code>{prep?.filename ?? `${String(img.seq).padStart(2, '0')}_${img.caption}.jpg`}</code>
                        </p>
                        {prep?.status === 'error' && (
                          <p className="mt-0.5 text-danger">변환 오류: {prep.error}</p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={!isApproved || isPreparingImages || !prep?.jpegFile}
                          onClick={() => prep && handleCopySinglePng(prep)}
                          className="pill-btn min-h-[44px] flex-1 border border-cta bg-surface px-3 text-xs font-semibold text-cta disabled:opacity-45"
                        >
                          PC PNG 복사 (Ctrl+V)
                        </button>
                        <button
                          type="button"
                          disabled={!isApproved || isPreparingImages || !prep?.jpegFile}
                          onClick={() => prep?.jpegFile && triggerSingleFileDownload(prep.jpegFile)}
                          className="pill-btn min-h-[44px] flex-1 border border-ink/20 bg-surface px-3 text-xs font-semibold text-ink disabled:opacity-45"
                        >
                          개별 JPEG 저장
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* 4. 일반 텍스트 폴백용 서식 안내 */}
          {copyPayload && copyPayload.formattingGuide.length > 0 && (
            <section className="card-surface p-6">
              <h3 className="text-base font-semibold text-ink">
                일반 텍스트 붙여넣기 시 서식 적용 안내
              </h3>
              <p className="mt-1 text-xs text-ink-soft">
                붙여넣은 앱에서 HTML 서식이 유지되지 않을 때 아래 문장을 소제목/굵게로 지정하세요.
              </p>
              <ul className="mt-3 flex flex-col gap-1.5 text-xs">
                {copyPayload.formattingGuide.map((item, idx) => (
                  <li key={`${item.kind}-${idx}`} className="flex items-center gap-2">
                    <StatusBadge
                      tone={item.kind === '소제목' ? 'success' : 'neutral'}
                      icon={item.kind === '소제목' ? 'H' : 'B'}
                      label={item.kind}
                    />
                    <span className="text-ink">{item.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
