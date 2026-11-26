import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ALLOWED_CONTENT_TYPES_BY_DISCOVERY_MODE,
  type CategoriesListResponse,
  type CategoryProfile,
  type CategoryResponse,
  type ContentType,
  type CreateCategoryRequest,
  type DeleteCategoryResponse,
  type DiscoveryMode,
  type UpdateCategoryRequest,
  type Visibility
} from '@content-desk/shared';
import {
  createCategory,
  deleteCategory,
  fetchCategories,
  getApiErrorMessage,
  updateCategory
} from '../lib/api-client';
import { StatusBadge } from '../components/StatusBadge';
import { BottomActionBar } from '../components/BottomActionBar';

export interface CategoriesPageProps {
  listCategories?: () => Promise<CategoriesListResponse>;
  addCategory?: (input: CreateCategoryRequest) => Promise<CategoryResponse>;
  editCategory?: (id: string, input: UpdateCategoryRequest) => Promise<CategoryResponse>;
  removeCategory?: (id: string) => Promise<DeleteCategoryResponse>;
}

const DISCOVERY_MODE_LABELS: Record<DiscoveryMode, string> = {
  trend_first: '트렌드 우선 (trend_first)',
  experience_first: '경험 우선 (experience_first)',
  none: '개인 기록 · 발굴 없음 (none)'
};

const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  explainer: '개념·트렌드 해설 (explainer)',
  experience_review: '실사용·방문 후기 (experience_review)',
  vlog: '일상/브이로그 (vlog)'
};

function parseCsvTokens(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

interface CategoryFormState {
  displayName: string;
  naverBoardName: string;
  discoveryMode: DiscoveryMode;
  datalabAnchorKeyword: string;
  seedKeywordsRaw: string;
  primarySourceDomainsRaw: string;
  allowedContentTypes: ContentType[];
  minRealPhotos: number;
  requireFieldMemo: boolean;
  defaultVisibility: Visibility;
}

function createInitialFormState(): CategoryFormState {
  return {
    displayName: '',
    naverBoardName: '',
    discoveryMode: 'experience_first',
    datalabAnchorKeyword: '',
    seedKeywordsRaw: '',
    primarySourceDomainsRaw: '',
    allowedContentTypes: ['experience_review'],
    minRealPhotos: 0,
    requireFieldMemo: false,
    defaultVisibility: '전체공개'
  };
}

function formStateFromCategory(cat: CategoryProfile): CategoryFormState {
  return {
    displayName: cat.display_name,
    naverBoardName: cat.naver_board_name,
    discoveryMode: cat.discovery_mode,
    datalabAnchorKeyword: cat.datalab_anchor_keyword ?? '',
    seedKeywordsRaw: cat.seed_keywords.join(', '),
    primarySourceDomainsRaw: cat.primary_source_domains.join(', '),
    allowedContentTypes: [...cat.default_media_policy.allowed_content_types],
    minRealPhotos: cat.default_media_policy.min_real_photos,
    requireFieldMemo: cat.default_media_policy.require_field_memo,
    defaultVisibility: cat.default_visibility
  };
}

export function CategoriesPage({
  listCategories = fetchCategories,
  addCategory = createCategory,
  editCategory = updateCategory,
  removeCategory = deleteCategory
}: CategoriesPageProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CategoryFormState>(createInitialFormState);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null
  );

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: listCategories,
    retry: false
  });

  const createMutation = useMutation({
    mutationFn: (payload: CreateCategoryRequest) => addCategory(payload),
    onSuccess: (res) => {
      setForm(createInitialFormState());
      setFeedback({
        tone: 'success',
        text: `카테고리 "${res.category.display_name}"을(를) 생성했습니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (err) => {
      setFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '카테고리 생성에 실패했습니다.')
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateCategoryRequest }) =>
      editCategory(id, payload),
    onSuccess: (res) => {
      setEditingId(null);
      setForm(createInitialFormState());
      setFeedback({
        tone: 'success',
        text: `카테고리 "${res.category.display_name}"을(를) 수정했습니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (err) => {
      setFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '카테고리 수정에 실패했습니다.')
      });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => removeCategory(id),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '카테고리를 삭제했습니다.' });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (err) => {
      setFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '카테고리 삭제에 실패했습니다.')
      });
    }
  });

  const allowedTypesForMode = ALLOWED_CONTENT_TYPES_BY_DISCOVERY_MODE[form.discoveryMode];
  const needsAnchor = form.discoveryMode !== 'none';
  const needsPrimaryDomains = form.allowedContentTypes.includes('explainer');
  const isSubmitting = createMutation.isPending || updateMutation.isPending;

  const handleDiscoveryModeChange = (nextMode: DiscoveryMode) => {
    const allowed = [...ALLOWED_CONTENT_TYPES_BY_DISCOVERY_MODE[nextMode]];
    setForm((prev) => ({
      ...prev,
      discoveryMode: nextMode,
      allowedContentTypes: [allowed[0]!],
      datalabAnchorKeyword: nextMode === 'none' ? '' : prev.datalabAnchorKeyword
    }));
  };

  const handleToggleContentType = (ct: ContentType) => {
    setForm((prev) => {
      const exists = prev.allowedContentTypes.includes(ct);
      if (exists) {
        if (prev.allowedContentTypes.length <= 1) return prev;
        return {
          ...prev,
          allowedContentTypes: prev.allowedContentTypes.filter((item) => item !== ct)
        };
      }
      return {
        ...prev,
        allowedContentTypes: [...prev.allowedContentTypes, ct]
      };
    });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    const displayName = form.displayName.trim();
    const naverBoardName = form.naverBoardName.trim();
    const anchor = form.datalabAnchorKeyword.trim();
    const seedKeywords = parseCsvTokens(form.seedKeywordsRaw);
    const primarySourceDomains = parseCsvTokens(form.primarySourceDomainsRaw);

    if (!displayName || !naverBoardName) {
      setFeedback({
        tone: 'danger',
        text: '카테고리 표시명과 네이버 블로그 게시판명을 모두 입력해 주세요.'
      });
      return;
    }

    if (needsAnchor && !anchor) {
      setFeedback({
        tone: 'danger',
        text: '트렌드 우선 또는 경험 우선 모드에서는 데이터랩 기준 키워드가 필수입니다.'
      });
      return;
    }

    if (needsPrimaryDomains && primarySourceDomains.length === 0) {
      setFeedback({
        tone: 'danger',
        text: '해설(explainer) 형식을 허용하는 경우 1차 출처 도메인을 1개 이상 입력해 주세요.'
      });
      return;
    }

    const payload: CreateCategoryRequest = {
      display_name: displayName,
      naver_board_name: naverBoardName,
      discovery_mode: form.discoveryMode,
      datalab_anchor_keyword: needsAnchor ? anchor : null,
      seed_keywords: seedKeywords,
      primary_source_domains: primarySourceDomains,
      default_media_policy: {
        allowed_content_types: form.allowedContentTypes,
        min_real_photos: form.minRealPhotos,
        require_field_memo: form.requireFieldMemo
      },
      default_visibility: form.defaultVisibility
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const startEdit = (cat: CategoryProfile) => {
    setFeedback(null);
    setEditingId(cat.category_id);
    setForm(formStateFromCategory(cat));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(createInitialFormState());
    setFeedback(null);
  };

  return (
    <div className="flex flex-col gap-5 pb-4">
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-brand">
              {editingId ? '카테고리 수정' : '비YMYL 카테고리 등록'}
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              네이버 블로그 게시판과 발굴 방식·허용 콘텐츠 형식 조합을 카테고리별로 관리합니다.
            </p>
          </div>
          <StatusBadge tone="warning" icon="!" label="YMYL 주제 차단 적용" />
        </div>

        <p className="mt-3 rounded-lg bg-canvas p-3 text-xs text-ink-soft">
          정책 안내: 의료·건강·질병·처방, 금융·투자·주식·코인·대출·보험·세금·부동산 청약,
          법률·소송 등 고위험 YMYL 주제는 1차 키워드 및 AI 판정으로 자동 차단됩니다.
        </p>

        <form id="category-form" onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>카테고리 표시명</span>
              <input
                type="text"
                value={form.displayName}
                onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
                placeholder="예: 맛집, 테크/IT, 일상/브이로그"
                maxLength={60}
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>네이버 블로그 게시판명</span>
              <input
                type="text"
                value={form.naverBoardName}
                onChange={(e) => setForm((prev) => ({ ...prev, naverBoardName: e.target.value }))}
                placeholder="예: 성수동 맛집 기록"
                maxLength={60}
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>글감 발굴 방식 (discovery_mode)</span>
              <select
                value={form.discoveryMode}
                onChange={(e) => handleDiscoveryModeChange(e.target.value as DiscoveryMode)}
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
              >
                {(['trend_first', 'experience_first', 'none'] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {DISCOVERY_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>기본 공개 범위</span>
              <select
                value={form.defaultVisibility}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, defaultVisibility: e.target.value as Visibility }))
                }
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
              >
                <option value="전체공개">전체공개</option>
                <option value="이웃공개">이웃공개</option>
              </select>
            </label>
          </div>

          <fieldset className="rounded-xl border border-ink/15 bg-surface-subtle p-4">
            <legend className="px-1 text-sm font-semibold text-ink">
              허용 콘텐츠 형식 (선택한 발굴 방식 기준)
            </legend>
            <div className="mt-2 flex flex-wrap gap-3">
              {allowedTypesForMode.map((ct) => {
                const checked = form.allowedContentTypes.includes(ct);
                return (
                  <label
                    key={ct}
                    className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-medium ${
                      checked
                        ? 'border-cta bg-success-bg text-brand'
                        : 'border-ink/20 bg-surface text-ink'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleToggleContentType(ct)}
                      className="h-4 w-4"
                    />
                    <span>{CONTENT_TYPE_LABELS[ct]}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {needsAnchor && (
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>데이터랩 기준 키워드 (필수)</span>
              <input
                type="text"
                value={form.datalabAnchorKeyword}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, datalabAnchorKeyword: e.target.value }))
                }
                placeholder="예: 성수동 맛집, 클라우드"
                maxLength={50}
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
              />
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>시드 키워드 (쉼표 구분, 선택)</span>
              <input
                type="text"
                value={form.seedKeywordsRaw}
                onChange={(e) => setForm((prev) => ({ ...prev, seedKeywordsRaw: e.target.value }))}
                placeholder="예: 카페 투어, 디저트, 브런치"
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>
                1차 출처 허용 도메인 (쉼표 구분{needsPrimaryDomains ? ', explainer 필수' : ', 선택'})
              </span>
              <input
                type="text"
                value={form.primarySourceDomainsRaw}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, primarySourceDomainsRaw: e.target.value }))
                }
                placeholder="예: developers.cloudflare.com, react.dev"
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              <span>권장 최소 실사 사진 수 (0~20)</span>
              <input
                type="number"
                min={0}
                max={20}
                value={form.minRealPhotos}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    minRealPhotos: Math.max(0, Math.min(20, Number.parseInt(e.target.value || '0', 10) || 0))
                  }))
                }
                className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
              />
            </label>

            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 self-end rounded-lg border border-ink/15 bg-surface-subtle px-4 text-sm font-medium text-ink">
              <input
                type="checkbox"
                checked={form.requireFieldMemo}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, requireFieldMemo: e.target.checked }))
                }
                className="h-4 w-4"
              />
              <span>현장 메모 입력 권장</span>
            </label>
          </div>
        </form>

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
            <h3 className="text-lg font-semibold text-ink">내 카테고리 목록</h3>
            {categoriesQuery.data && (
              <p className="mt-0.5 text-xs text-ink-soft">
                총 {categoriesQuery.data.categories.length}개 등록됨
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void categoriesQuery.refetch()}
            disabled={categoriesQuery.isFetching}
            className="pill-btn border border-ink/20 bg-surface px-4 text-sm font-medium text-ink disabled:opacity-60"
          >
            {categoriesQuery.isFetching ? '조회 중...' : '새로고침'}
          </button>
        </div>

        {categoriesQuery.isLoading && (
          <p className="mt-4 text-sm text-ink-soft">카테고리를 불러오고 있습니다...</p>
        )}

        {categoriesQuery.error && (
          <div role="alert" className="mt-4 rounded-xl bg-danger-bg p-4 text-sm text-danger">
            {getApiErrorMessage(categoriesQuery.error, '카테고리 목록을 불러오지 못했습니다.')}
          </div>
        )}

        {categoriesQuery.data && categoriesQuery.data.categories.length === 0 && (
          <p className="mt-4 rounded-xl bg-surface-subtle p-4 text-sm text-ink-soft">
            아직 등록된 카테고리가 없습니다. 위 양식에서 첫 비YMYL 카테고리를 추가해 보세요.
          </p>
        )}

        {categoriesQuery.data && categoriesQuery.data.categories.length > 0 && (
          <div className="mt-4 flex flex-col gap-3">
            {categoriesQuery.data.categories.map((cat) => (
              <article
                key={cat.category_id}
                data-testid={`category-row-${cat.category_id}`}
                className="rounded-xl border border-ink/10 bg-surface-subtle p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-base font-semibold text-ink">{cat.display_name}</h4>
                      <StatusBadge tone="success" icon="•" label={cat.discovery_mode} />
                      <StatusBadge tone="neutral" icon="📋" label={cat.naver_board_name} />
                      <StatusBadge tone="neutral" icon="👁" label={cat.default_visibility} />
                    </div>

                    <p className="mt-2 text-xs text-ink-soft">
                      허용 형식: {cat.default_media_policy.allowed_content_types.join(', ')}
                      {cat.datalab_anchor_keyword
                        ? ` · 기준 키워드: ${cat.datalab_anchor_keyword}`
                        : ''}
                    </p>

                    {cat.seed_keywords.length > 0 && (
                      <p className="mt-1 text-xs text-ink-soft">
                        시드: {cat.seed_keywords.join(', ')}
                      </p>
                    )}

                    {cat.primary_source_domains.length > 0 && (
                      <p className="mt-1 text-xs text-ink-soft">
                        1차 출처 도메인: {cat.primary_source_domains.join(', ')}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(cat)}
                      className="pill-btn border border-ink/20 bg-surface px-4 text-sm font-medium text-ink"
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate(cat.category_id)}
                      disabled={deleteMutation.isPending}
                      className="pill-btn border border-danger/40 bg-danger-bg px-4 text-sm font-semibold text-danger disabled:opacity-60"
                    >
                      삭제
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <BottomActionBar ariaLabel="카테고리 저장 작업 바">
        <span className="text-xs text-ink-soft">
          {editingId ? '선택한 카테고리를 수정 중입니다.' : '비YMYL 새 카테고리를 추가할 수 있습니다.'}
        </span>
        <div className="flex items-center gap-2">
          {editingId && (
            <button
              type="button"
              onClick={cancelEdit}
              className="pill-btn border border-ink/20 bg-surface px-5 text-sm font-medium text-ink"
            >
              수정 취소
            </button>
          )}
          <button
            type="submit"
            form="category-form"
            disabled={isSubmitting}
            className="pill-btn bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:opacity-60"
          >
            {isSubmitting
              ? editingId
                ? '수정 중...'
                : '생성 중...'
              : editingId
                ? '카테고리 수정 저장'
                : '카테고리 추가'}
          </button>
        </div>
      </BottomActionBar>
    </div>
  );
}
