import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_CAPTURE_PHOTOS,
  type CaptureContentType,
  type CapturePhoto,
  type CapturePresignRequest,
  type CapturePresignResponse,
  type CaptureResponse,
  type CapturesListResponse,
  type CaptureUploadMime,
  type CategoriesListResponse,
  type CreateCaptureRequest,
  type LlmConsentRequest
} from '@content-desk/shared';
import {
  consentCaptureLlm,
  createCapture,
  fetchCaptures,
  fetchCategories,
  getApiErrorMessage,
  presignCaptureUploads,
  uploadBlobToPresignedUrl
} from '../lib/api-client';
import { readCaptureMeta, type CaptureExifMeta } from '../platform/exif';
import {
  encodeCaptureImage,
  ImageEncodeError,
  type EncodedCaptureImage
} from '../platform/image-encode';
import { StatusBadge } from '../components/StatusBadge';
import { BottomActionBar } from '../components/BottomActionBar';

export interface MobileUploadPageProps {
  listCategories?: () => Promise<CategoriesListResponse>;
  listCaptures?: (categoryId?: string) => Promise<CapturesListResponse>;
  requestPresign?: (input: CapturePresignRequest) => Promise<CapturePresignResponse>;
  submitCapture?: (input: CreateCaptureRequest) => Promise<CaptureResponse>;
  submitConsent?: (id: string, input: LlmConsentRequest) => Promise<CaptureResponse>;
  extractExif?: (file: Blob) => Promise<CaptureExifMeta>;
  encodeImage?: (file: Blob) => Promise<EncodedCaptureImage>;
  uploadToR2?: (
    uploadUrl: string,
    blob: Blob,
    contentType: CaptureUploadMime,
    expectedByteSize?: number
  ) => Promise<void>;
  onNavigateCategories?: () => void;
}

interface PendingPhotoDraft {
  id: string;
  file: File;
  caption: string;
}

function getCaptureContentTypes(allowed: readonly string[]): CaptureContentType[] {
  return allowed.filter(
    (ct): ct is CaptureContentType => ct === 'experience_review' || ct === 'vlog'
  );
}

function formatIsoShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function MobileUploadPage({
  listCategories = fetchCategories,
  listCaptures = fetchCaptures,
  requestPresign = presignCaptureUploads,
  submitCapture = createCapture,
  submitConsent = consentCaptureLlm,
  extractExif = (file) => readCaptureMeta(file),
  encodeImage = (file) => encodeCaptureImage(file),
  uploadToR2 = (url, blob, mime, expectedByteSize) =>
    uploadBlobToPresignedUrl(url, blob, mime, expectedByteSize),
  onNavigateCategories
}: MobileUploadPageProps) {
  const queryClient = useQueryClient();
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [contentType, setContentType] = useState<CaptureContentType>('experience_review');
  const [pendingPhotos, setPendingPhotos] = useState<PendingPhotoDraft[]>([]);
  const [fieldMemo, setFieldMemo] = useState('');
  const [isSponsored, setIsSponsored] = useState(false);
  const [providerName, setProviderName] = useState('');
  const [compensationType, setCompensationType] = useState('');
  const [progressText, setProgressText] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null
  );
  const [consentError, setConsentError] = useState<string | null>(null);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: listCategories,
    retry: false
  });

  const capturesQuery = useQuery({
    queryKey: ['captures'],
    queryFn: () => listCaptures(),
    retry: false
  });

  const eligibleCategories = useMemo(() => {
    const all = categoriesQuery.data?.categories ?? [];
    return all.filter((cat) => getCaptureContentTypes(cat.default_media_policy.allowed_content_types).length > 0);
  }, [categoriesQuery.data]);

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categoriesQuery.data?.categories ?? []) {
      map.set(cat.category_id, cat.display_name);
    }
    return map;
  }, [categoriesQuery.data]);

  const activeCategory = useMemo(
    () => eligibleCategories.find((c) => c.category_id === selectedCategoryId) ?? eligibleCategories[0] ?? null,
    [eligibleCategories, selectedCategoryId]
  );

  const availableContentTypes = useMemo(
    () =>
      activeCategory
        ? getCaptureContentTypes(activeCategory.default_media_policy.allowed_content_types)
        : [],
    [activeCategory]
  );

  useEffect(() => {
    if (activeCategory && activeCategory.category_id !== selectedCategoryId) {
      setSelectedCategoryId(activeCategory.category_id);
    }
  }, [activeCategory, selectedCategoryId]);

  useEffect(() => {
    if (availableContentTypes.length > 0 && !availableContentTypes.includes(contentType)) {
      setContentType(availableContentTypes[0]!);
    }
  }, [availableContentTypes, contentType]);

  const consentMutation = useMutation({
    mutationFn: (captureId: string) =>
      submitConsent(captureId, { acknowledged_free_tier_training: true }),
    onSuccess: () => {
      setConsentError(null);
      void queryClient.invalidateQueries({ queryKey: ['captures'] });
    },
    onError: (err) => {
      setConsentError(getApiErrorMessage(err, '무료 LLM 전송 동의 저장에 실패했습니다.'));
    }
  });

  const handleFileSelection = (e: ChangeEvent<HTMLInputElement>) => {
    setFeedback(null);
    const selected = Array.from(e.target.files ?? []);
    if (selected.length === 0) return;

    setPendingPhotos((prev) => {
      const remaining = MAX_CAPTURE_PHOTOS - prev.length;
      if (remaining <= 0) {
        setFeedback({
          tone: 'danger',
          text: `사진은 최대 ${MAX_CAPTURE_PHOTOS}장까지 선택할 수 있습니다.`
        });
        return prev;
      }
      const next = selected.slice(0, remaining).map((file, idx) => ({
        id: `${Date.now()}-${idx}-${file.name}`,
        file,
        caption: ''
      }));
      if (selected.length > remaining) {
        setFeedback({
          tone: 'danger',
          text: `최대 ${MAX_CAPTURE_PHOTOS}장까지만 추가되어 일부 사진은 제외되었습니다.`
        });
      }
      return [...prev, ...next];
    });
    e.target.value = '';
  };

  const handleRemovePhoto = (id: string) => {
    setPendingPhotos((prev) => prev.filter((item) => item.id !== id));
  };

  const handleCaptionChange = (id: string, caption: string) => {
    setPendingPhotos((prev) =>
      prev.map((item) => (item.id === id ? { ...item, caption } : item))
    );
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    if (!activeCategory) {
      setFeedback({
        tone: 'danger',
        text: '먼저 후기 또는 브이로그를 허용하는 카테고리를 등록해 주세요.'
      });
      return;
    }

    const trimmedMemo = fieldMemo.trim();
    if (pendingPhotos.length === 0 && trimmedMemo.length === 0) {
      setFeedback({
        tone: 'danger',
        text: '실사 사진 또는 현장 메모 중 최소 1건 이상 입력해야 합니다.'
      });
      return;
    }

    if (isSponsored && (!providerName.trim() || !compensationType.trim())) {
      setFeedback({
        tone: 'danger',
        text: '협찬 글은 제공 주체와 제공 형태를 모두 입력해야 합니다.'
      });
      return;
    }

    setIsUploading(true);
    setProgressText(null);

    try {
      const captureId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `cap-${Date.now()}`;

      const uploadedPhotos: CapturePhoto[] = [];

      if (pendingPhotos.length > 0) {
        const prepared: Array<{
          seq: number;
          caption: string;
          takenAt: string | null;
          encoded: EncodedCaptureImage;
        }> = [];

        // 1장씩 순차 전처리(EXIF 추출 + 재인코딩으로 GPS 완전 제거)
        for (let i = 0; i < pendingPhotos.length; i += 1) {
          const draft = pendingPhotos[i]!;
          setProgressText(`사진 전처리 중 (${i + 1}/${pendingPhotos.length})...`);
          const meta = await extractExif(draft.file);
          const encoded = await encodeImage(draft.file);
          prepared.push({
            seq: i + 1,
            caption: draft.caption.trim(),
            takenAt: meta.takenAt,
            encoded
          });
        }

        setProgressText('업로드 서명 URL 발급 중...');
        const presign = await requestPresign({
          capture_id: captureId,
          category_id: activeCategory.category_id,
          files: prepared.map((item) => ({
            seq: item.seq,
            content_type: item.encoded.contentType,
            byte_size: item.encoded.byteSize
          }))
        });

        const uploadMap = new Map(presign.uploads.map((u) => [u.seq, u]));

        for (let i = 0; i < prepared.length; i += 1) {
          const item = prepared[i]!;
          const target = uploadMap.get(item.seq);
          if (!target) {
            throw new Error(`서명 URL 응답에 사진 순번 ${item.seq}이(가) 누락되었습니다.`);
          }
          if (item.encoded.blob.size !== item.encoded.byteSize) {
            throw new Error(
              `사진 ${item.seq}의 실제 크기가 서명 요청 크기와 일치하지 않아 업로드를 중단했습니다.`
            );
          }
          setProgressText(`R2 안전 업로드 중 (${i + 1}/${prepared.length})...`);
          await uploadToR2(
            target.upload_url,
            item.encoded.blob,
            target.content_type,
            item.encoded.byteSize
          );
          uploadedPhotos.push({
            seq: item.seq,
            r2_key: target.r2_key,
            mime_type: target.content_type,
            byte_size: item.encoded.byteSize,
            taken_at: item.takenAt,
            width: item.encoded.width,
            height: item.encoded.height,
            caption: item.caption
          });
        }
      }

      setProgressText('캡처 자료를 저장하고 있습니다...');
      await submitCapture({
        capture_id: captureId,
        category_id: activeCategory.category_id,
        content_type: contentType,
        photos: uploadedPhotos,
        field_memo: fieldMemo,
        sponsorship: isSponsored
          ? {
              is_sponsored: true,
              provider_name: providerName.trim(),
              compensation_type: compensationType.trim()
            }
          : { is_sponsored: false },
        store_location_consent: false
      });

      setPendingPhotos([]);
      setFieldMemo('');
      setIsSponsored(false);
      setProviderName('');
      setCompensationType('');
      setProgressText(null);
      setFeedback({
        tone: 'success',
        text:
          uploadedPhotos.length > 0
            ? `위치 정보가 제거된 사진 ${uploadedPhotos.length}장과 메모를 저장했습니다.`
            : '현장 메모를 저장했습니다.'
      });
      void queryClient.invalidateQueries({ queryKey: ['captures'] });
    } catch (err) {
      setProgressText(null);
      const message =
        err instanceof ImageEncodeError
          ? err.message
          : getApiErrorMessage(err, '자료 업로드 중 오류가 발생했습니다.');
      setFeedback({ tone: 'danger', text: message });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 pb-4">
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-brand">현장 사진·메모 올리기</h2>
            <p className="mt-1 text-sm text-ink-soft">
              업로드 전 기기에서 사진을 2,560px 이하 WebP/JPEG로 다시 인코딩해 GPS 위치 정보를
              완전히 제거합니다. 사진 없이 현장 메모만 단독으로 저장할 수도 있습니다.
            </p>
          </div>
          <StatusBadge tone="success" icon="🔒" label="GPS 자동 제거" />
        </div>

        {categoriesQuery.isLoading && (
          <p className="mt-4 text-sm text-ink-soft">카테고리를 불러오고 있습니다...</p>
        )}

        {!categoriesQuery.isLoading && eligibleCategories.length === 0 && (
          <div className="mt-4 rounded-xl bg-canvas p-4 text-sm text-ink">
            <p className="font-medium">
              사진·메모를 올릴 수 있는 카테고리(후기 또는 브이로그 허용)가 아직 없습니다.
            </p>
            <p className="mt-1 text-xs text-ink-soft">
              카테고리 화면에서 경험 우선(맛집·여행) 또는 일상/브이로그 카테고리를 먼저 만들어
              주세요.
            </p>
            {onNavigateCategories && (
              <button
                type="button"
                onClick={onNavigateCategories}
                className="pill-btn mt-3 bg-cta px-5 text-sm font-semibold text-ink-inverse"
              >
                카테고리 만들러 가기
              </button>
            )}
          </div>
        )}

        <form id="capture-upload-form" onSubmit={(e) => void handleSubmit(e)} className="mt-5 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>카테고리</span>
              <select
                value={activeCategory?.category_id ?? ''}
                onChange={(e) => setSelectedCategoryId(e.target.value)}
                disabled={eligibleCategories.length === 0 || isUploading}
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none disabled:opacity-60"
              >
                {eligibleCategories.map((cat) => (
                  <option key={cat.category_id} value={cat.category_id}>
                    {cat.display_name} ({cat.naver_board_name})
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>콘텐츠 형식</span>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value as CaptureContentType)}
                disabled={availableContentTypes.length === 0 || isUploading}
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none disabled:opacity-60"
              >
                {availableContentTypes.map((ct) => (
                  <option key={ct} value={ct}>
                    {ct === 'experience_review' ? '실사용·방문 후기 (experience_review)' : '일상/브이로그 (vlog)'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="rounded-xl border border-dashed border-brand/35 bg-surface-subtle p-4">
            <label className="flex flex-col gap-2 text-sm font-medium text-ink">
              <span>실사 사진 선택 (선택 · 최대 {MAX_CAPTURE_PHOTOS}장, GPS 미전송)</span>
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={isUploading}
                onChange={handleFileSelection}
                className="min-h-[44px] cursor-pointer rounded-lg border border-ink/20 bg-surface p-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-cta file:px-4 file:py-1.5 file:text-sm file:font-semibold file:text-ink-inverse"
              />
            </label>
            <p className="mt-2 text-xs text-ink-soft">
              변환에 실패한 사진(HEIF 미지원 등)은 개인정보 보호를 위해 원본 업로드를 차단합니다.
            </p>

            {pendingPhotos.length > 0 && (
              <ul className="mt-3 flex flex-col gap-2.5">
                {pendingPhotos.map((item, index) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-ink/10 bg-surface p-3"
                  >
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-semibold text-brand">
                      {index + 1}
                    </span>
                    <span className="max-w-[180px] truncate text-xs font-medium text-ink">
                      {item.file.name}
                    </span>
                    <input
                      type="text"
                      aria-label={`사진 ${index + 1} 캡션`}
                      value={item.caption}
                      onChange={(e) => handleCaptionChange(item.id, e.target.value)}
                      placeholder="사진 설명 캡션 (선택)"
                      maxLength={120}
                      disabled={isUploading}
                      className="min-h-[44px] min-w-[160px] flex-1 rounded-lg border border-ink/20 bg-surface px-3 text-base text-ink focus:border-cta focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemovePhoto(item.id)}
                      disabled={isUploading}
                      className="pill-btn border border-danger/30 bg-danger-bg px-3.5 text-xs font-semibold text-danger disabled:opacity-60"
                    >
                      제거
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>현장 메모 (사진 없이 메모 단독 저장 가능)</span>
            <textarea
              rows={4}
              value={fieldMemo}
              onChange={(e) => setFieldMemo(e.target.value)}
              maxLength={4000}
              disabled={isUploading}
              placeholder="방문 장소, 맛·느낌, 가격, 제품 사용 소감 등 실제 경험을 자유롭게 기록해 주세요."
              className="rounded-lg border border-ink/20 bg-surface p-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
          </label>

          <div className="rounded-xl border border-ink/15 bg-surface-subtle p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm font-medium text-ink">
                <input
                  type="checkbox"
                  checked={isSponsored}
                  onChange={(e) => setIsSponsored(e.target.checked)}
                  disabled={isUploading}
                  className="h-4 w-4"
                />
                <span>협찬·경제적 이해관계 포함</span>
              </label>
              {isSponsored && <StatusBadge tone="sponsored" icon="★" label="협찬 표시 대상" />}
            </div>

            {isSponsored && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs font-medium text-ink">
                  <span>제공 주체 (필수)</span>
                  <input
                    type="text"
                    value={providerName}
                    onChange={(e) => setProviderName(e.target.value)}
                    placeholder="예: OO브랜드"
                    maxLength={100}
                    disabled={isUploading}
                    className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3 text-base text-ink"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-ink">
                  <span>제공 형태 (필수)</span>
                  <input
                    type="text"
                    value={compensationType}
                    onChange={(e) => setCompensationType(e.target.value)}
                    placeholder="예: 제품 무상 제공, 식사권 제공"
                    maxLength={100}
                    disabled={isUploading}
                    className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3 text-base text-ink"
                  />
                </label>
              </div>
            )}
          </div>
        </form>

        {progressText && (
          <p role="status" className="mt-4 rounded-lg bg-brand-tint px-3.5 py-2.5 text-sm font-medium text-brand">
            {progressText}
          </p>
        )}

        {feedback && (
          <p
            role={feedback.tone === 'danger' ? 'alert' : 'status'}
            className={`mt-4 rounded-lg px-3.5 py-2.5 text-sm ${
              feedback.tone === 'danger'
                ? 'bg-danger-bg text-danger'
                : 'bg-success-bg text-brand'
            }`}
          >
            {feedback.text}
          </p>
        )}
      </section>

      <section className="card-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-ink">저장된 캡처 목록 (메타데이터)</h3>
            <p className="mt-0.5 text-xs text-ink-soft">
              원고 생성 전 무료 LLM 제공자 전송 동의를 미리 기록할 수 있습니다. 이미지 원본
              다운로드는 Phase 4 수동 복사 패널에서 제공됩니다.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void capturesQuery.refetch()}
            disabled={capturesQuery.isFetching}
            className="pill-btn border border-ink/20 bg-surface px-4 text-sm font-medium text-ink disabled:opacity-60"
          >
            {capturesQuery.isFetching ? '조회 중...' : '새로고침'}
          </button>
        </div>

        {consentError && (
          <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3.5 py-2.5 text-sm text-danger">
            {consentError}
          </p>
        )}

        {capturesQuery.isLoading && (
          <p className="mt-4 text-sm text-ink-soft">캡처 목록을 불러오고 있습니다...</p>
        )}

        {capturesQuery.error && (
          <div role="alert" className="mt-4 rounded-xl bg-danger-bg p-4 text-sm text-danger">
            {getApiErrorMessage(capturesQuery.error, '캡처 목록을 불러오지 못했습니다.')}
          </div>
        )}

        {capturesQuery.data && capturesQuery.data.captures.length === 0 && (
          <p className="mt-4 rounded-xl bg-surface-subtle p-4 text-sm text-ink-soft">
            저장된 캡처가 없습니다. 위에서 사진이나 현장 메모를 올려 보세요.
          </p>
        )}

        {capturesQuery.data && capturesQuery.data.captures.length > 0 && (
          <div className="mt-4 flex flex-col gap-3">
            {capturesQuery.data.captures.map((cap) => {
              const catName = categoryNameById.get(cap.category_id) ?? cap.category_id;
              const consented = Boolean(cap.llm_consent_at);
              return (
                <article
                  key={cap.capture_id}
                  data-testid={`capture-row-${cap.capture_id}`}
                  className="rounded-xl border border-ink/10 bg-surface-subtle p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-base font-semibold text-ink">{catName}</h4>
                        <StatusBadge tone="neutral" icon="•" label={cap.content_type} />
                        <StatusBadge
                          tone="neutral"
                          icon="📷"
                          label={`사진 ${cap.photos.length}장`}
                        />
                        {cap.sponsorship.is_sponsored && (
                          <StatusBadge tone="sponsored" icon="★" label="협찬" />
                        )}
                        <StatusBadge
                          tone={consented ? 'success' : 'warning'}
                          icon={consented ? '✓' : '!'}
                          label={consented ? 'LLM 전송 동의됨' : 'LLM 전송 동의 필요'}
                        />
                      </div>

                      <p className="mt-2 text-sm text-ink">
                        {cap.field_memo.trim().length > 0 ? cap.field_memo : '(현장 메모 없음)'}
                      </p>

                      <p className="mt-1.5 text-xs text-ink-soft">
                        저장 시각: {formatIsoShort(cap.created_at)}
                        {cap.llm_consent_at
                          ? ` · 동의 시각: ${formatIsoShort(cap.llm_consent_at)}`
                          : ''}
                      </p>
                    </div>

                    {!consented && (
                      <button
                        type="button"
                        onClick={() => consentMutation.mutate(cap.capture_id)}
                        disabled={consentMutation.isPending}
                        className="pill-btn border border-cta bg-surface px-4 text-sm font-semibold text-cta disabled:opacity-60"
                      >
                        무료 LLM 전송 동의
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <BottomActionBar ariaLabel="현장 자료 저장 바">
        <span className="text-xs text-ink-soft">
          선택 사진 {pendingPhotos.length}장 · 메모 {fieldMemo.trim().length}자
        </span>
        <button
          type="submit"
          form="capture-upload-form"
          disabled={isUploading || eligibleCategories.length === 0}
          className="pill-btn bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:opacity-60"
        >
          {isUploading ? '처리 중...' : '자료 올리기'}
        </button>
      </BottomActionBar>
    </div>
  );
}
