import { useEffect, useRef, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { User } from 'firebase/auth';
import { registerApiClientHooks } from './lib/api-client';
import { subscribeAuthState } from './lib/firebase';
import { queryClient } from './lib/query-client';
import { LoginPage } from './pages/LoginPage';
import { AccessDeniedPage } from './pages/AccessDeniedPage';
import { Phase1HomePage } from './pages/Phase1HomePage';
import { ReauthModal } from './components/ReauthModal';

interface AccessDeniedState {
  code: 'USER_NOT_REGISTERED' | 'USER_BLOCKED';
  uid: string;
}

export function App() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [accessDenied, setAccessDenied] = useState<AccessDeniedState | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [d1LimitResetAt, setD1LimitResetAt] = useState<string | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const reauthResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const currentUidRef = useRef<string>('');

  useEffect(() => {
    registerApiClientHooks({
      onSessionExpired: (message) => {
        setSessionNotice(message);
        setAccessDenied(null);
        queryClient.clear();
      },
      onReauthRequired: () =>
        new Promise<boolean>((resolve) => {
          reauthResolverRef.current = resolve;
          setReauthOpen(true);
        }),
      onD1LimitExceeded: (resetAt) => {
        setD1LimitResetAt(resetAt ?? '다음 UTC 00:00');
      },
      onAccessDenied: (code, uid) => {
        setAccessDenied({ code, uid: uid ?? currentUidRef.current });
      }
    });

    const unsub = subscribeAuthState((nextUser) => {
      currentUidRef.current = nextUser?.uid ?? '';
      setUser(nextUser);
      setAccessDenied(null);
      setAuthReady(true);
      if (nextUser) {
        setSessionNotice(null);
      } else {
        queryClient.clear();
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
        accessDenied ? (
          <AccessDeniedPage code={accessDenied.code} uid={accessDenied.uid || user.uid} />
        ) : (
          <Phase1HomePage user={user} d1LimitResetAt={d1LimitResetAt} />
        )
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
