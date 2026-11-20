import { useEffect, useRef, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { User } from 'firebase/auth';
import { registerApiClientHooks } from './lib/api-client';
import { subscribeAuthState } from './lib/firebase';
import { queryClient } from './lib/query-client';
import { LoginPage } from './pages/LoginPage';
import { Phase1HomePage } from './pages/Phase1HomePage';
import { ReauthModal } from './components/ReauthModal';

export function App() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [d1LimitResetAt, setD1LimitResetAt] = useState<string | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const reauthResolverRef = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    registerApiClientHooks({
      onSessionExpired: (message) => {
        setSessionNotice(message);
        queryClient.clear();
      },
      onReauthRequired: () =>
        new Promise<boolean>((resolve) => {
          reauthResolverRef.current = resolve;
          setReauthOpen(true);
        }),
      onD1LimitExceeded: (resetAt) => {
        setD1LimitResetAt(resetAt ?? '다음 UTC 00:00');
      }
    });

    const unsub = subscribeAuthState((nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) {
        setSessionNotice(null);
      }
    });

    return () => {
      unsub();
    };
  }, []);

  const handleReauthSuccess = () => {
    setReauthOpen(false);
    reauthResolverRef.current?.(true);
    reauthResolverRef.current = null;
  };

  const handleReauthCancel = () => {
    setReauthOpen(false);
    reauthResolverRef.current?.(false);
    reauthResolverRef.current = null;
  };

  if (!authReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas p-6">
        <p className="text-sm text-ink-soft">로그인 상태를 확인하고 있습니다...</p>
      </main>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      {user ? (
        <Phase1HomePage user={user} d1LimitResetAt={d1LimitResetAt} />
      ) : (
        <LoginPage notice={sessionNotice} />
      )}
      <ReauthModal
        open={reauthOpen}
        onSuccess={handleReauthSuccess}
        onCancel={handleReauthCancel}
      />
    </QueryClientProvider>
  );
}
