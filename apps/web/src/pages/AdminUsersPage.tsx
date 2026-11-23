import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminUserItem,
  AdminUserMutationResponse,
  AdminUsersListResponse,
  CreateAdminUserRequest,
  UpdateAdminUserRequest
} from '@content-desk/shared';
import {
  createAdminUser,
  fetchAdminUsers,
  getApiErrorMessage,
  updateAdminUser
} from '../lib/api-client';
import { StatusBadge } from '../components/StatusBadge';

export interface AdminUsersPageProps {
  listUsers?: () => Promise<AdminUsersListResponse>;
  addUser?: (input: CreateAdminUserRequest) => Promise<AdminUserMutationResponse>;
  patchUser?: (uid: string, input: UpdateAdminUserRequest) => Promise<AdminUserMutationResponse>;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '환경 변수 (ADMIN_UIDS)';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function AdminUsersPage({
  listUsers = fetchAdminUsers,
  addUser = createAdminUser,
  patchUser = updateAdminUser
}: AdminUsersPageProps) {
  const queryClient = useQueryClient();
  const [newUid, setNewUid] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [formFeedback, setFormFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null
  );
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [rowError, setRowError] = useState<string | null>(null);

  const usersQuery = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: listUsers,
    retry: false
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateAdminUserRequest) => addUser(input),
    onSuccess: (res) => {
      setNewUid('');
      setNewLabel('');
      setFormFeedback({
        tone: 'success',
        text: `${res.user.label} (${res.user.uid}) 사용자를 등록했습니다.`
      });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err) => {
      setFormFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '사용자 등록에 실패했습니다.')
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ uid, input }: { uid: string; input: UpdateAdminUserRequest }) =>
      patchUser(uid, input),
    onSuccess: () => {
      setEditingUid(null);
      setEditingLabel('');
      setRowError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err) => {
      setRowError(getApiErrorMessage(err, '사용자 상태 변경에 실패했습니다.'));
    }
  });

  const handleAddSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFormFeedback(null);
    const trimmedUid = newUid.trim();
    const trimmedLabel = newLabel.trim();
    if (!trimmedUid || !trimmedLabel) {
      setFormFeedback({
        tone: 'danger',
        text: 'Firebase UID와 사용자 라벨을 모두 입력해 주세요.'
      });
      return;
    }
    createMutation.mutate({ uid: trimmedUid, label: trimmedLabel });
  };

  const startEditLabel = (item: AdminUserItem) => {
    setRowError(null);
    setEditingUid(item.uid);
    setEditingLabel(item.label);
  };

  const handleSaveLabel = (uid: string) => {
    const trimmed = editingLabel.trim();
    if (!trimmed) {
      setRowError('라벨은 비워 둘 수 없습니다.');
      return;
    }
    updateMutation.mutate({ uid, input: { label: trimmed } });
  };

  const handleToggleStatus = (item: AdminUserItem) => {
    setRowError(null);
    const nextStatus = item.status === 'active' ? 'blocked' : 'active';
    updateMutation.mutate({ uid: item.uid, input: { status: nextStatus } });
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-brand">사용자 관리 (관리자 전용)</h2>
            <p className="mt-1 text-sm text-ink-soft">
              등록된 사용자와 당일 공유 API 호출 횟수(숫자)만 관리합니다. 다른 사용자의 글감·원고·사진·발행
              기록에는 접근할 수 없습니다.
            </p>
          </div>
          <StatusBadge tone="neutral" icon="🛡" label="15분 재인증 보호" />
        </div>

        <form onSubmit={handleAddSubmit} className="mt-5 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>Firebase UID</span>
            <input
              type="text"
              value={newUid}
              onChange={(e) => setNewUid(e.target.value)}
              placeholder="사용자에게 전달받은 UID 붙여넣기"
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>사용자 라벨 (메모)</span>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="예: 홍길동 (가족)"
              maxLength={60}
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
          </label>

          <button
            type="submit"
            disabled={createMutation.isPending}
            className="pill-btn bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:opacity-60"
          >
            {createMutation.isPending ? '등록 중...' : '사용자 추가'}
          </button>
        </form>

        {formFeedback && (
          <p
            role={formFeedback.tone === 'danger' ? 'alert' : 'status'}
            className={`mt-3 rounded-lg px-3.5 py-2.5 text-sm ${
              formFeedback.tone === 'danger'
                ? 'bg-danger-bg text-danger'
                : 'bg-success-bg text-brand'
            }`}
          >
            {formFeedback.text}
          </p>
        )}
      </section>

      <section className="card-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-ink">등록 사용자 및 당일 호출 횟수</h3>
            {usersQuery.data && (
              <p className="mt-0.5 text-xs text-ink-soft">
                집계 기준일: {usersQuery.data.windowDate} (UTC) · 총 {usersQuery.data.users.length}명
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void usersQuery.refetch()}
            disabled={usersQuery.isFetching}
            className="pill-btn border border-ink/20 bg-surface px-4 text-sm font-medium text-ink disabled:opacity-60"
          >
            {usersQuery.isFetching ? '조회 중...' : '새로고침'}
          </button>
        </div>

        {rowError && (
          <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3.5 py-2.5 text-sm text-danger">
            {rowError}
          </p>
        )}

        {usersQuery.isLoading && (
          <p className="mt-4 text-sm text-ink-soft">사용자 목록을 불러오고 있습니다...</p>
        )}

        {usersQuery.error && (
          <div role="alert" className="mt-4 rounded-xl bg-danger-bg p-4 text-sm text-danger">
            <p>{getApiErrorMessage(usersQuery.error, '사용자 목록을 불러오지 못했습니다.')}</p>
            <button
              type="button"
              onClick={() => void usersQuery.refetch()}
              className="pill-btn mt-3 border border-danger/30 bg-surface px-4 text-sm font-semibold text-danger"
            >
              다시 시도
            </button>
          </div>
        )}

        {usersQuery.data && (
          <div className="mt-4 flex flex-col gap-3">
            {usersQuery.data.users.map((item) => {
              const isAdmin = item.role === 'admin';
              const isEditing = editingUid === item.uid;
              const providerEntries = Object.entries(item.todayUsage.byProvider);

              return (
                <article
                  key={item.uid}
                  data-testid={`admin-user-row-${item.uid}`}
                  className="rounded-xl border border-ink/10 bg-surface-subtle p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {isEditing ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              aria-label={`${item.uid} 라벨 입력`}
                              value={editingLabel}
                              onChange={(e) => setEditingLabel(e.target.value)}
                              maxLength={60}
                              className="min-h-[44px] rounded-lg border border-cta bg-surface px-3 text-base text-ink"
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveLabel(item.uid)}
                              disabled={updateMutation.isPending}
                              className="pill-btn bg-cta px-4 text-sm font-semibold text-ink-inverse disabled:opacity-60"
                            >
                              저장
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingUid(null)}
                              className="pill-btn border border-ink/20 bg-surface px-4 text-sm font-medium text-ink"
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <h4 className="text-base font-semibold text-ink">{item.label}</h4>
                        )}

                        <StatusBadge
                          tone={isAdmin ? 'success' : 'neutral'}
                          icon={isAdmin ? '★' : '•'}
                          label={isAdmin ? '관리자' : '일반 사용자'}
                        />
                        <StatusBadge
                          tone={item.status === 'active' ? 'success' : 'danger'}
                          icon={item.status === 'active' ? '✓' : '⛔'}
                          label={item.status === 'active' ? '활성' : '차단됨'}
                        />
                      </div>

                      <p className="mt-1.5 break-all font-mono text-xs text-ink-soft">{item.uid}</p>

                      <dl className="mt-3 grid gap-2 text-xs text-ink-soft sm:grid-cols-2">
                        <div>
                          <dt className="inline font-medium text-ink">등록일: </dt>
                          <dd className="inline">{formatDateTime(item.createdAt)}</dd>
                        </div>
                        <div>
                          <dt className="inline font-medium text-ink">당일 호출 횟수: </dt>
                          <dd className="inline font-semibold text-brand">
                            {item.todayUsage.totalCalls}회
                          </dd>
                          {providerEntries.length > 0 && (
                            <span className="ml-1.5">
                              ({providerEntries.map(([k, v]) => `${k} ${v}`).join(', ')})
                            </span>
                          )}
                        </div>
                      </dl>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {isAdmin ? (
                        <span className="text-xs font-medium text-ink-soft">차단 불가</span>
                      ) : (
                        <>
                          {!isEditing && (
                            <button
                              type="button"
                              onClick={() => startEditLabel(item)}
                              disabled={updateMutation.isPending}
                              className="pill-btn border border-ink/20 bg-surface px-4 text-sm font-medium text-ink disabled:opacity-60"
                            >
                              라벨 수정
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(item)}
                            disabled={updateMutation.isPending}
                            className={`pill-btn px-4 text-sm font-semibold disabled:opacity-60 ${
                              item.status === 'active'
                                ? 'border border-danger/40 bg-danger-bg text-danger'
                                : 'bg-cta text-ink-inverse'
                            }`}
                          >
                            {item.status === 'active' ? '차단' : '차단 해제'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
