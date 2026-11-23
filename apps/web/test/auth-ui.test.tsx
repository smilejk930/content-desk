import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminUsersListResponse, MeResponse } from '@content-desk/shared';
import { injectApiOriginIntoHeaders } from '../src/lib/csp';
import {
  ApiRequestError,
  fetchAdminUsers,
  registerApiClientHooks
} from '../src/lib/api-client';
import * as firebaseLib from '../src/lib/firebase';
import { LoginPage } from '../src/pages/LoginPage';
import { AccessDeniedPage } from '../src/pages/AccessDeniedPage';
import { AdminUsersPage } from '../src/pages/AdminUsersPage';
import { Phase1HomePage } from '../src/pages/Phase1HomePage';
import { ReauthModal } from '../src/components/ReauthModal';

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  registerApiClientHooks({});
  vi.restoreAllMocks();
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

describe('AccessDeniedPage (미등록 UID 복사 / 차단 안내)', () => {
  it('displays UID and copies it to clipboard for USER_NOT_REGISTERED', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    });
    const signOutMock = vi.fn();

    render(
      <AccessDeniedPage
        code="USER_NOT_REGISTERED"
        uid="unregistered-uid-123"
        onSignOut={signOutMock}
      />
    );

    expect(screen.getByTestId('denied-uid')).toHaveTextContent('unregistered-uid-123');
    fireEvent.click(screen.getByRole('button', { name: 'UID 복사' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('unregistered-uid-123');
      expect(screen.getByRole('status')).toHaveTextContent('클립보드에 복사');
    });

    const signOutButtons = screen.getAllByRole('button', { name: '로그아웃' });
    fireEvent.click(signOutButtons[0]!);
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it('displays blocked guidance without UID copy button for USER_BLOCKED', () => {
    const signOutMock = vi.fn();
    render(
      <AccessDeniedPage code="USER_BLOCKED" uid="blocked-uid-999" onSignOut={signOutMock} />
    );

    expect(screen.getByText(/접근이 차단된 계정/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'UID 복사' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '로그아웃' })[0]!);
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});

describe('Phase1HomePage & AdminUsersPage (역할별 메뉴 노출 · 추가 · 차단 · 재인증 연동)', () => {
  const baseMe: Omit<MeResponse, 'role'> = {
    uid: 'owner-uid-1',
    email: 'owner@example.com',
    auth_time: 1732000000,
    session_expires_at: '2026-12-04T00:00:00.000Z',
    reauth_valid_until: '2026-11-23T00:15:00.000Z',
    d1_connected: true
  };

  it('hides admin menu for normal users and renders d1LimitResetAt value properly', async () => {
    renderWithQuery(
      <Phase1HomePage
        user={{ uid: 'user-normal-1' }}
        d1LimitResetAt="2026-11-24T00:00:00.000Z"
        loadMe={async () => ({ ...baseMe, uid: 'user-normal-1', role: 'user' })}
        onSignOut={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('인증 및 백엔드 연결 정상')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: '사용자 관리' })).toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('2026-11-24T00:00:00.000Z');
    expect(alert.textContent).not.toContain('${d1LimitResetAt}');
  });

  it('renders AccessDeniedPage when /api/me returns 403 USER_NOT_REGISTERED', async () => {
    renderWithQuery(
      <Phase1HomePage
        user={{ uid: 'stranger-uid-1' }}
        d1LimitResetAt={null}
        loadMe={async () => {
          throw new ApiRequestError(403, 'USER_NOT_REGISTERED', '미등록 계정', {
            details: { uid: 'stranger-uid-1' }
          });
        }}
        onSignOut={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('denied-uid')).toHaveTextContent('stranger-uid-1');
    });
  });

  it('exposes admin menu only to admin role, displays numeric daily usage, and handles add/block actions', async () => {
    let usersState: AdminUsersListResponse = {
      windowDate: '2026-11-23',
      users: [
        {
          uid: 'owner-uid-1',
          label: '관리자 (ADMIN_UIDS)',
          status: 'active',
          role: 'admin',
          createdAt: null,
          updatedAt: null,
          statusChangedAt: null,
          todayUsage: {
            date: '2026-11-23',
            totalCalls: 5,
            byProvider: { naver_search: 5 }
          }
        },
        {
          uid: 'user-a-001',
          label: '사용자 A',
          status: 'active',
          role: 'user',
          createdAt: '2026-11-23T01:00:00.000Z',
          updatedAt: '2026-11-23T01:00:00.000Z',
          statusChangedAt: '2026-11-23T01:00:00.000Z',
          todayUsage: {
            date: '2026-11-23',
            totalCalls: 14,
            byProvider: { naver_search: 10, gemini: 4 }
          }
        }
      ]
    };

    const listUsersMock = vi.fn(async () => structuredClone(usersState));
    const addUserMock = vi.fn(async (input: { uid: string; label: string }) => {
      const created = {
        uid: input.uid,
        label: input.label,
        status: 'active' as const,
        role: 'user' as const,
        createdAt: '2026-11-23T02:00:00.000Z',
        updatedAt: '2026-11-23T02:00:00.000Z',
        statusChangedAt: '2026-11-23T02:00:00.000Z',
        todayUsage: { date: '2026-11-23', totalCalls: 0, byProvider: {} }
      };
      usersState = { ...usersState, users: [...usersState.users, created] };
      return { user: created };
    });
    const patchUserMock = vi.fn(async (uid: string, input: { label?: string; status?: 'active' | 'blocked' }) => {
      usersState = {
        ...usersState,
        users: usersState.users.map((u) =>
          u.uid === uid
            ? {
                ...u,
                label: input.label ?? u.label,
                status: input.status ?? u.status
              }
            : u
        )
      };
      const updated = usersState.users.find((u) => u.uid === uid)!;
      return { user: updated };
    });

    renderWithQuery(
      <Phase1HomePage
        user={{ uid: 'owner-uid-1' }}
        d1LimitResetAt={null}
        loadMe={async () => ({ ...baseMe, role: 'admin' })}
        onSignOut={vi.fn()}
        adminPageProps={{
          listUsers: listUsersMock,
          addUser: addUserMock,
          patchUser: patchUserMock
        }}
      />
    );

    const adminNavBtn = await screen.findByRole('button', { name: '사용자 관리' });
    fireEvent.click(adminNavBtn);

    const adminRow = await screen.findByTestId('admin-user-row-owner-uid-1');
    expect(within(adminRow).queryByRole('button', { name: '차단' })).toBeNull();
    expect(within(adminRow).getByText('5회')).toBeInTheDocument();

    const userRow = screen.getByTestId('admin-user-row-user-a-001');
    expect(within(userRow).getByText('14회')).toBeInTheDocument();

    // Add new user
    fireEvent.change(screen.getByLabelText('Firebase UID'), {
      target: { value: 'user-b-002' }
    });
    fireEvent.change(screen.getByLabelText('사용자 라벨 (메모)'), {
      target: { value: '사용자 B' }
    });
    fireEvent.click(screen.getByRole('button', { name: '사용자 추가' }));

    await waitFor(() => {
      expect(addUserMock).toHaveBeenCalledWith({ uid: 'user-b-002', label: '사용자 B' });
      expect(screen.getByTestId('admin-user-row-user-b-002')).toBeInTheDocument();
    });

    // Edit label for user A
    fireEvent.click(within(screen.getByTestId('admin-user-row-user-a-001')).getByRole('button', { name: '라벨 수정' }));
    fireEvent.change(screen.getByLabelText('user-a-001 라벨 입력'), {
      target: { value: '사용자 A (수정)' }
    });
    fireEvent.click(within(screen.getByTestId('admin-user-row-user-a-001')).getByRole('button', { name: '저장' }));
    await waitFor(() => {
      expect(patchUserMock).toHaveBeenCalledWith('user-a-001', { label: '사용자 A (수정)' });
    });

    // Block user A
    fireEvent.click(within(screen.getByTestId('admin-user-row-user-a-001')).getByRole('button', { name: '차단' }));
    await waitFor(() => {
      expect(patchUserMock).toHaveBeenCalledWith('user-a-001', { status: 'blocked' });
    });
  });

  it('triggers 15-minute reauth hook and retries GET /api/admin/users on 401 REAUTH_REQUIRED', async () => {
    vi.spyOn(firebaseLib, 'getCurrentIdToken').mockResolvedValue('mock-id-token');

    let attempt = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'REAUTH_REQUIRED',
              message: '최근 15분 이내 Google 재인증이 필요합니다.'
            }
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          windowDate: '2026-11-23',
          users: [
            {
              uid: 'owner-uid-1',
              label: '관리자 (ADMIN_UIDS)',
              status: 'active',
              role: 'admin',
              createdAt: null,
              updatedAt: null,
              statusChangedAt: null,
              todayUsage: { date: '2026-11-23', totalCalls: 3, byProvider: { naver_search: 3 } }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const onReauthRequired = vi.fn(async () => true);
    registerApiClientHooks({ onReauthRequired });

    renderWithQuery(<AdminUsersPage listUsers={fetchAdminUsers} />);

    await waitFor(() => {
      expect(onReauthRequired).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('admin-user-row-owner-uid-1')).toBeInTheDocument();
      expect(screen.getByText('3회')).toBeInTheDocument();
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
