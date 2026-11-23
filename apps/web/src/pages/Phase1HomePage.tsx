import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ExportResponse, MeResponse } from '@content-desk/shared';
import type { User } from 'firebase/auth';
import {
  ApiRequestError,
  fetchMe,
  getApiErrorMessage,
  triggerExport
} from '../lib/api-client';
import { signOutUser } from '../lib/firebase';
import { StatusBadge } from '../components/StatusBadge';
import { AccessDeniedPage } from './AccessDeniedPage';
import { AdminUsersPage, type AdminUsersPageProps } from './AdminUsersPage';

export interface Phase1HomePageProps {
  user: Pick<User, 'uid'>;
  d1LimitResetAt: string | null;
  loadMe?: () => Promise<MeResponse>;
  runExport?: () => Promise<ExportResponse>;
  onSignOut?: () => Promise<void> | void;
  adminPageProps?: AdminUsersPageProps;
}

type ActiveTab = 'home' | 'admin-users';

export function Phase1HomePage({
  user,
  d1LimitResetAt,
  loadMe = fetchMe,
  runExport = triggerExport,
  onSignOut = signOutUser,
  adminPageProps
}: Phase1HomePageProps) {
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('home');

  const meQuery = useQuery({
    queryKey: ['me', user.uid],
    queryFn: loadMe,
    retry: false
  });

  const exportMutation = useMutation({
    mutationFn: runExport,
    onSuccess: (data) => {
      setExportMessage(`본인 데이터 내보내기 확인 완료 (시각: ${data.exported_at})`);
    },
    onError: (err) => {
      setExportMessage(getApiErrorMessage(err, '내보내기 요청이 실패했습니다.'));
    }
  });

  if (
    meQuery.error instanceof ApiRequestError &&
    (meQuery.error.code === 'USER_NOT_REGISTERED' || meQuery.error.code === 'USER_BLOCKED')
  ) {
    const deniedUid =
      typeof meQuery.error.details?.uid === 'string' ? meQuery.error.details.uid : user.uid;
    return <AccessDeniedPage code={meQuery.error.code} uid={deniedUid} onSignOut={onSignOut} />;
  }

  const isAdmin = meQuery.data?.role === 'admin';
  const currentTab: ActiveTab = isAdmin ? activeTab : 'home';

  return (
    <main className="flex min-h-dvh flex-col bg-canvas">
      <header className="bg-band px-5 py-4 text-ink-inverse">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs text-ink-inverse-soft">PHASE 1.5 MULTI-USER</p>
            <h1 className="text-xl font-semibold">Content Desk</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isAdmin && (
              <nav aria-label="관리자 메뉴" className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveTab('home')}
                  aria-current={currentTab === 'home' ? 'page' : undefined}
                  className={`pill-btn px-4 text-sm font-semibold ${
                    currentTab === 'home'
                      ? 'bg-surface text-cta'
                      : 'border border-ink-inverse/30 text-ink-inverse'
                  }`}
                >
                  홈
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('admin-users')}
                  aria-current={currentTab === 'admin-users' ? 'page' : undefined}
                  className={`pill-btn px-4 text-sm font-semibold ${
                    currentTab === 'admin-users'
                      ? 'bg-surface text-cta'
                      : 'border border-ink-inverse/30 text-ink-inverse'
                  }`}
                >
                  사용자 관리
                </button>
              </nav>
            )}

            <button
              type="button"
              onClick={() => void onSignOut()}
              className="pill-btn border border-ink-inverse/30 px-4 text-sm font-medium text-ink-inverse"
            >
              로그아웃
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-5 py-6">
        {d1LimitResetAt && (
          <div role="alert" className="rounded-xl bg-warning px-4 py-3 text-sm font-medium text-warning-ink">
            D1 무료 일일 한도에 도달했습니다. UTC 자정({d1LimitResetAt}) 이후 다시 시도해 주세요.
          </div>
        )}

        {meQuery.isLoading && (
          <section className="card-surface p-6">
            <p className="text-sm text-ink-soft">인증 및 D1 연결 상태를 확인하고 있습니다...</p>
          </section>
        )}

        {meQuery.error && (
          <section className="card-surface p-6">
            <StatusBadge tone="danger" icon="!" label="API 오류" />
            <p className="mt-3 text-sm text-danger">
              {getApiErrorMessage(meQuery.error, '상태 조회에 실패했습니다.')}
            </p>
          </section>
        )}

        {meQuery.data && currentTab === 'admin-users' && isAdmin && (
          <AdminUsersPage {...adminPageProps} />
        )}

        {meQuery.data && currentTab === 'home' && (
          <>
            <section className="card-surface p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-brand">인증 및 백엔드 연결 정상</h2>
                  <p className="mt-1 text-sm text-ink-soft">{meQuery.data.email ?? meQuery.data.uid}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    tone={isAdmin ? 'success' : 'neutral'}
                    icon={isAdmin ? '★' : '•'}
                    label={isAdmin ? '관리자' : '일반 사용자'}
                  />
                  <StatusBadge
                    tone={meQuery.data.d1_connected ? 'success' : 'warning'}
                    icon={meQuery.data.d1_connected ? '✓' : '!'}
                    label={meQuery.data.d1_connected ? 'D1 연결됨' : 'D1 확인 필요'}
                  />
                </div>
              </div>

              <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg bg-surface-subtle p-3.5">
                  <dt className="text-xs text-ink-soft">Firebase UID</dt>
                  <dd className="mt-1 break-all font-mono text-sm text-ink">{meQuery.data.uid}</dd>
                </div>
                <div className="rounded-lg bg-surface-subtle p-3.5">
                  <dt className="text-xs text-ink-soft">최대 세션 만료 (14일)</dt>
                  <dd className="mt-1 text-sm text-ink">{meQuery.data.session_expires_at}</dd>
                </div>
                <div className="rounded-lg bg-surface-subtle p-3.5">
                  <dt className="text-xs text-ink-soft">민감 작업 재인증 유효 (15분)</dt>
                  <dd className="mt-1 text-sm text-ink">{meQuery.data.reauth_valid_until}</dd>
                </div>
                <div className="rounded-lg bg-surface-subtle p-3.5">
                  <dt className="text-xs text-ink-soft">다음 단계</dt>
                  <dd className="mt-1 text-sm text-ink">Phase 2: 카테고리·사진 업로드(R2)</dd>
                </div>
              </dl>
            </section>

            <section className="card-surface p-6">
              <h3 className="text-lg font-semibold text-ink">민감 작업 15분 재인증 검증</h3>
              <p className="mt-1 text-sm text-ink-soft">
                최근 로그인 후 15분이 지난 상태에서 아래 버튼을 누르면{' '}
                <code>401 REAUTH_REQUIRED</code> 응답을 받고 Google 팝업 재인증 모달이 자동으로
                열립니다. 내보내기에는 본인 소유의 데이터만 포함됩니다.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => exportMutation.mutate()}
                  disabled={exportMutation.isPending}
                  className="pill-btn bg-cta px-5 text-sm font-semibold text-ink-inverse disabled:opacity-60"
                >
                  {exportMutation.isPending ? '내보내기 확인 중...' : '본인 데이터 JSON 내보내기 테스트'}
                </button>
                {exportMessage && <span className="text-sm text-ink-soft">{exportMessage}</span>}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
