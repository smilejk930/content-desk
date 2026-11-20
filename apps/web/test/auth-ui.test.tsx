import { injectApiOriginIntoHeaders } from '../src/lib/csp';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../src/pages/LoginPage';
import { ReauthModal } from '../src/components/ReauthModal';

afterEach(() => {
  cleanup();
});

describe('LoginPage (Google 단독 팝업 로그인)', () => {
  it('contains no email/password inputs or signup UI and calls signIn synchronously on click', () => {
    let calledSynchronously = false;
    const signInMock = vi.fn(() => {
      calledSynchronously = true;
      return Promise.resolve({});
    });

    const { container } = render(<LoginPage signIn={signInMock} standalone={false} />);

    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByText(/회원가입/)).toBeNull();
    expect(screen.queryByText(/비밀번호/)).toBeNull();

    const btn = screen.getByRole('button', { name: /Google 계정으로 로그인/ });
    fireEvent.click(btn);

    // Must be called synchronously inside click handler before any microtask
    expect(calledSynchronously).toBe(true);
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it('shows popup-blocked guidance on auth/popup-blocked error', async () => {
    const signInMock = vi.fn(() => Promise.reject({ code: 'auth/popup-blocked' }));
    render(<LoginPage signIn={signInMock} standalone={false} />);

    fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 로그인/ }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('팝업이 차단');
    });
  });

  it('shows standalone browser-tab guidance when popup fails in standalone mode', async () => {
    const signInMock = vi.fn(() => Promise.reject({ code: 'auth/popup-closed-by-user' }));
    render(<LoginPage signIn={signInMock} standalone={true} />);

    fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 로그인/ }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('일반 브라우저 탭');
    });
  });
});

describe('ReauthModal (15분 Google 팝업 재인증)', () => {
  it('invokes reauthenticate synchronously on click and calls onSuccess', async () => {
    let calledSync = false;
    const reauthMock = vi.fn(() => {
      calledSync = true;
      return Promise.resolve('fresh-id-token');
    });
    const onSuccess = vi.fn();
    const onCancel = vi.fn();

    render(
      <ReauthModal
        open={true}
        onSuccess={onSuccess}
        onCancel={onCancel}
        reauthenticate={reauthMock}
        standalone={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Google로 다시 인증/ }));
    expect(calledSync).toBe(true);

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it('shows standalone fallback message when reauth fails in standalone mode', async () => {
    const reauthMock = vi.fn(() => Promise.reject({ code: 'auth/popup-blocked' }));
    render(
      <ReauthModal
        open={true}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
        reauthenticate={reauthMock}
        standalone={true}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Google로 다시 인증/ }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('일반 브라우저 탭');
    });
  });
});

describe('Pages _headers CSP connect-src Worker 출처 주입', () => {
  const baseHeaders =
    "/*\n  Cross-Origin-Opener-Policy: same-origin-allow-popups\n  Content-Security-Policy: default-src 'self'; connect-src 'self' https://identitytoolkit.googleapis.com;\n";

  it('injects Worker origin into connect-src when VITE_API_BASE_URL is configured', () => {
    const out = injectApiOriginIntoHeaders(
      baseHeaders,
      'https://content-desk-worker.example.workers.dev/api'
    );
    expect(out).toContain("connect-src 'self' https://content-desk-worker.example.workers.dev");
  });

  it('keeps _headers unchanged when VITE_API_BASE_URL is empty (same-origin / local proxy)', () => {
    expect(injectApiOriginIntoHeaders(baseHeaders, '')).toBe(baseHeaders);
  });
});
