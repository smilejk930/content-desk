import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ExportResponse, MeResponse } from '@content-desk/shared';
import type { User } from 'firebase/auth';
import { apiClient, ApiRequestError, unwrapJson } from '../lib/api-client';
import { signOutUser } from '../lib/firebase';
import { StatusBadge } from '../components/StatusBadge';

interface Phase1HomePageProps {
  user: User;
  d1LimitResetAt: string | null;
}

export function Phase1HomePage({ user, d1LimitResetAt }: Phase1HomePageProps) {
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const meQuery = useQuery({
    queryKey: ['me', user.uid],
    queryFn: async () => {
      const res = await apiClient.api.me.$get();
      return unwrapJson<MeResponse>(res);
    }
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.api.export.$post();
      return unwrapJson<ExportResponse>(res);
    },
    onSuccess: (data) => {
      setExportMessage(`전체 내보내기 확인 완료 (시각: ${data.exported_at})`);
    },
    onError: (err) => {
      setExportMessage(err instanceof Error ? err.message : '내보내기 요청이 실패했습니다.');
    }
  });

  const isUidDenied =
    meQuery.error instanceof ApiRequestError && meQuery.error.code === 'UID_NOT_ALLOWED';

  return (
    <main className="flex min-h-dvh flex-col bg-canvas">
      <header className="bg-band px-5 py-4 text-ink-inverse">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div>
            <p className="text-xs text-ink-inverse-soft">PHASE 1 FOUNDATION</p>
            <h1 className="text-xl font-semibold">Content Desk</h1>
          </div>
          <button
            type="button"
            onClick={() => void signOutUser()}
            className="pill-btn border border-ink-inverse/30 px-4 text-sm font-medium text-ink-inverse"
          >
            로그아웃
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-5 py-6">
        {d1LimitResetAt && (
          <div role="alert" className="rounded-xl bg-warning px-4 py-3 text-sm font-medium text-warning-ink">
            D1 무료 일일 한도에 도달했습니다. UTC 자정(${d1LimitResetAt}) 이후 다시 시도해 주세요.
          </div>
        )}

        {meQuery.isLoading && (
          <section className="card-surface p-6">
            <p className="text-sm text-ink-soft">인증 및 D1 연결 상태를 확인하고 있습니다...</p>
          </section>
        )}

        {isUidDenied && (
          <section className="card-surface border border-danger/30 p-6">
            <StatusBadge tone="danger" icon="⛔" label="접근 차단 (403 UID_NOT_ALLOWED)" />
            <h2 className="mt-3 text-xl font-semibold text-ink">허용 UID 목록에 등록되지 않은 계정입니다</h2>
            <p className="mt-2 text-sm text-ink-soft">
              오너 본인 계정으로 최초 로그인하셨다면 아래 UID를 Workers 환경 변수{' '}
              <code className="rounded bg-canvas-muted px-1.5 py-0.5 text-ink">ALLOWED_UIDS</code>에
              등록하고 재배포해 주세요.
            </p>
            <div className="mt-4 rounded-lg bg-surface-subtle p-4">
              <p className="text-xs text-ink-soft">현재 로그인된 Firebase UID</p>
              <p className="mt-1 select-all font-mono text-base font-semibold text-brand">{user.uid}</p>
            </div>
          </section>
        )}

        {meQuery.error && !isUidDenied && (
          <section className="card-surface p-6">
            <StatusBadge tone="danger" icon="!" label="API 오류" />
            <p className="mt-3 text-sm text-danger">{meQuery.error.message}</p>
          </section>
        )}

        {meQuery.data && (
          <>
            <section className="card-surface p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-brand">인증 및 백엔드 연결 정상</h2>
                  <p className="mt-1 text-sm text-ink-soft">{meQuery.data.email ?? meQuery.data.uid}</p>
                </div>
                <StatusBadge
                  tone={meQuery.data.d1_connected ? 'success' : 'warning'}
                  icon={meQuery.data.d1_connected ? '✓' : '!'}
                  label={meQuery.data.d1_connected ? 'D1 연결됨' : 'D1 확인 필요'}
                />
              </div>

              <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg bg-surface-subtle p-3.5">
                  <dt className="text-xs text-ink-soft">Firebase UID</dt>
                  <dd className="mt-1 font-mono text-sm text-ink">{meQuery.data.uid}</dd>
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
                열립니다.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => exportMutation.mutate()}
                  disabled={exportMutation.isPending}
                  className="pill-btn bg-cta px-5 text-sm font-semibold text-ink-inverse disabled:opacity-60"
                >
                  {exportMutation.isPending ? '내보내기 확인 중...' : '전체 JSON 내보내기 테스트'}
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
