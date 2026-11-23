import { useState } from 'react';
import { signOutUser } from '../lib/firebase';
import { StatusBadge } from '../components/StatusBadge';

export interface AccessDeniedPageProps {
  code: 'USER_NOT_REGISTERED' | 'USER_BLOCKED';
  uid: string;
  onSignOut?: () => Promise<void> | void;
}

export function AccessDeniedPage({
  code,
  uid,
  onSignOut = signOutUser
}: AccessDeniedPageProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const isNotRegistered = code === 'USER_NOT_REGISTERED';

  const handleCopyUid = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(uid);
        setCopyStatus('copied');
        return;
      }
      setCopyStatus('failed');
    } catch {
      setCopyStatus('failed');
    }
  };

  return (
    <main className="flex min-h-dvh flex-col bg-canvas">
      <header className="bg-band px-5 py-4 text-ink-inverse">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <div>
            <p className="text-xs tracking-wider text-ink-inverse-soft">CONTENT DESK</p>
            <h1 className="text-xl font-semibold">접근 안내</h1>
          </div>
          <button
            type="button"
            onClick={() => void onSignOut()}
            className="pill-btn border border-ink-inverse/30 px-4 text-sm font-medium text-ink-inverse"
          >
            로그아웃
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-xl flex-1 items-center px-5 py-10">
        <section className="card-surface w-full border border-danger/25 p-7">
          {isNotRegistered ? (
            <>
              <StatusBadge tone="danger" icon="⛔" label="미등록 계정 (403 USER_NOT_REGISTERED)" />
              <h2 className="mt-4 text-2xl font-semibold text-ink">
                아직 사용자로 등록되지 않은 계정입니다
              </h2>
              <p className="mt-2 text-sm text-ink-soft">
                Content Desk는 관리자가 등록한 사용자만 이용할 수 있습니다. 관리자에게 아래 UID를
                전달해 등록을 요청하세요.
              </p>

              <div className="mt-5 rounded-xl bg-surface-subtle p-4">
                <p className="text-xs font-medium text-ink-soft">내 Firebase UID</p>
                <p
                  data-testid="denied-uid"
                  className="mt-1 select-all break-all font-mono text-base font-semibold text-brand"
                >
                  {uid}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void handleCopyUid()}
                    className="pill-btn bg-cta px-5 text-sm font-semibold text-ink-inverse"
                  >
                    UID 복사
                  </button>
                  {copyStatus === 'copied' && (
                    <span role="status" className="text-sm font-medium text-brand">
                      UID를 클립보드에 복사했습니다.
                    </span>
                  )}
                  {copyStatus === 'failed' && (
                    <span role="alert" className="text-sm text-danger">
                      자동 복사에 실패했습니다. 위 UID를 직접 선택해 복사해 주세요.
                    </span>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <StatusBadge tone="danger" icon="⛔" label="접근 차단됨 (403 USER_BLOCKED)" />
              <h2 className="mt-4 text-2xl font-semibold text-ink">접근이 차단된 계정입니다</h2>
              <p className="mt-2 text-sm text-ink-soft">
                관리자에 의해 이 계정의 이용이 제한되었습니다. 계속 이용해야 한다면 관리자에게
                차단 해제를 요청해 주세요.
              </p>
            </>
          )}

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={() => void onSignOut()}
              className="pill-btn border border-ink/25 bg-surface px-5 text-sm font-semibold text-ink"
            >
              로그아웃
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
