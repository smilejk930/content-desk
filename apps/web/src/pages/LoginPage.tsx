import { useState } from 'react';
import {
  isStandaloneMode,
  mapAuthPopupError,
  signInWithGooglePopup
} from '../lib/firebase';

export interface LoginPageProps {
  notice?: string | null;
  signIn?: () => Promise<unknown>;
  standalone?: boolean;
}

export function LoginPage({
  notice,
  signIn = signInWithGooglePopup,
  standalone = isStandaloneMode()
}: LoginPageProps) {
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleGoogleSignIn = () => {
    setErrorMessage(null);
    setLoading(true);
    // Must invoke signInWithPopup directly in click handler with ZERO prior await.
    signIn()
      .then(() => {
        setLoading(false);
      })
      .catch((err: unknown) => {
        setLoading(false);
        setErrorMessage(mapAuthPopupError(err, standalone));
      });
  };

  return (
    <main className="flex min-h-dvh flex-col justify-between bg-canvas">
      <header className="bg-band px-6 py-5 text-ink-inverse">
        <div className="mx-auto max-w-3xl">
          <p className="text-xs tracking-wider text-ink-inverse-soft">PERSONAL EDITORIAL DESK</p>
          <h1 className="mt-1 text-2xl font-semibold">Content Desk</h1>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-md flex-1 items-center px-5 py-10">
        <div className="card-surface w-full p-7">
          <h2 className="text-2xl font-semibold text-brand">작성자 로그인</h2>
          <p className="mt-2 text-sm text-ink-soft">
            허용된 본인 Google 계정으로만 접근할 수 있습니다. 팝업 창에서 Google 계정을 선택해
            로그인해 주세요.
          </p>

          {notice && (
            <p role="status" className="mt-4 rounded-lg bg-warning px-3.5 py-2.5 text-sm font-medium text-warning-ink">
              {notice}
            </p>
          )}

          {standalone && (
            <p className="mt-4 rounded-lg bg-warning px-3.5 py-2.5 text-sm font-medium text-warning-ink">
              홈 화면 단독 실행 모드에서는 Google 로그인 팝업이 실패하거나 돌아오지 못할 수 있습니다.
              로그인에 실패하면 일반 브라우저 탭에서 열어 로그인해 주세요.
            </p>
          )}

          {errorMessage && (
            <p role="alert" className="mt-4 rounded-lg bg-danger-bg px-3.5 py-2.5 text-sm text-danger">
              {errorMessage}
            </p>
          )}

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="pill-btn mt-6 flex min-h-[48px] w-full items-center justify-center gap-2 bg-cta px-6 text-base font-semibold text-ink-inverse disabled:opacity-60"
          >
            {loading ? 'Google 로그인 진행 중...' : 'Google 계정으로 로그인'}
          </button>

          <p className="mt-4 text-xs text-ink-soft">
            오너 Google 계정의 2단계 인증(2FA) 활성화를 권장하며, 세션은 최대 14일 유지됩니다.
          </p>
        </div>
      </section>

      <footer className="bg-band px-6 py-4 text-xs text-ink-inverse-soft">
        <div className="mx-auto max-w-3xl">Firebase Auth Google 단독 · Cloudflare Workers + D1</div>
      </footer>
    </main>
  );
}
