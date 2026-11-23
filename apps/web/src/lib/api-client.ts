import { hc } from 'hono/client';
import type {
  AdminUserMutationResponse,
  AdminUsersListResponse,
  ApiErrorCode,
  ApiErrorPayload,
  CreateAdminUserRequest,
  ExportResponse,
  MeResponse,
  UpdateAdminUserRequest
} from '@content-desk/shared';
import type { AppType } from '@content-desk/worker/app-type';
import { getCurrentIdToken, signOutUser } from './firebase';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly resetAt?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options?: { resetAt?: string; details?: Record<string, unknown> }
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.resetAt = options?.resetAt;
    this.details = options?.details;
  }
}

export interface ApiClientHooks {
  onSessionExpired?: (message: string) => void;
  onReauthRequired?: () => Promise<boolean>;
  onD1LimitExceeded?: (resetAt?: string) => void;
  onAccessDenied?: (code: 'USER_NOT_REGISTERED' | 'USER_BLOCKED', uid?: string) => void;
}

let hooks: ApiClientHooks = {};

export function registerApiClientHooks(nextHooks: ApiClientHooks): void {
  hooks = nextHooks;
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

async function parseErrorPayload(res: Response): Promise<ApiErrorPayload | null> {
  try {
    const json = (await res.json()) as ApiErrorPayload;
    if (json && typeof json === 'object' && 'error' in json && json.error?.code) {
      return json;
    }
    return null;
  } catch {
    return null;
  }
}

async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  retriedAfterReauth = false
): Promise<Response> {
  const token = await getCurrentIdToken(retriedAfterReauth);
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(input, { ...init, headers });
  if (res.ok) return res;

  const cloned = res.clone();
  const payload = await parseErrorPayload(cloned);
  const code = payload?.error.code;

  if (res.status === 401 && code === 'SESSION_EXPIRED') {
    await signOutUser().catch(() => undefined);
    hooks.onSessionExpired?.(
      payload?.error.message ?? '세션이 만료되었습니다. 다시 로그인해 주세요.'
    );
    return res;
  }

  if (res.status === 401 && code === 'REAUTH_REQUIRED' && !retriedAfterReauth && hooks.onReauthRequired) {
    const ok = await hooks.onReauthRequired();
    if (ok) {
      return authenticatedFetch(input, init, true);
    }
    return res;
  }

  if (res.status === 403 && (code === 'USER_NOT_REGISTERED' || code === 'USER_BLOCKED')) {
    const uid =
      typeof payload?.error.details?.uid === 'string' ? payload.error.details.uid : undefined;
    hooks.onAccessDenied?.(code, uid);
    return res;
  }

  if (res.status === 503 && code === 'D1_DAILY_LIMIT_EXCEEDED') {
    hooks.onD1LimitExceeded?.(payload?.error.reset_at);
  }

  return res;
}

export const apiClient = hc<AppType>(API_BASE_URL || '/', {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => authenticatedFetch(input, init)
});

export async function unwrapJson<T>(res: Response): Promise<T> {
  if (res.ok) {
    return (await res.json()) as T;
  }
  const payload = await parseErrorPayload(res);
  if (payload) {
    throw new ApiRequestError(res.status, payload.error.code, payload.error.message, {
      resetAt: payload.error.reset_at,
      details: payload.error.details
    });
  }
  throw new ApiRequestError(res.status, 'INTERNAL_ERROR', `요청 실패 (HTTP ${res.status})`);
}

export function getApiErrorMessage(err: unknown, fallback = '요청 처리 중 오류가 발생했습니다.'): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'USER_NOT_REGISTERED':
        return '등록되지 않은 계정입니다. 관리자에게 UID를 전달해 등록을 요청해 주세요.';
      case 'USER_BLOCKED':
        return '차단된 계정입니다. 관리자에게 문의해 주세요.';
      case 'ADMIN_ONLY':
        return '관리자만 접근할 수 있는 기능입니다.';
      case 'USER_ALREADY_EXISTS':
        return '이미 등록되었거나 관리자 목록에 포함된 UID입니다.';
      case 'REAUTH_REQUIRED':
        return '최근 15분 이내 Google 재인증이 필요합니다.';
      default:
        return err.message || fallback;
    }
  }
  return err instanceof Error ? err.message : fallback;
}

export async function fetchMe(): Promise<MeResponse> {
  const res = await apiClient.api.me.$get();
  return unwrapJson<MeResponse>(res);
}

export async function triggerExport(): Promise<ExportResponse> {
  const res = await apiClient.api.export.$post();
  return unwrapJson<ExportResponse>(res);
}

export async function fetchAdminUsers(): Promise<AdminUsersListResponse> {
  const res = await apiClient.api.admin.users.$get();
  return unwrapJson<AdminUsersListResponse>(res);
}

export async function createAdminUser(
  input: CreateAdminUserRequest
): Promise<AdminUserMutationResponse> {
  const res = await apiClient.api.admin.users.$post({ json: input });
  return unwrapJson<AdminUserMutationResponse>(res);
}

export async function updateAdminUser(
  uid: string,
  input: UpdateAdminUserRequest
): Promise<AdminUserMutationResponse> {
  const res = await apiClient.api.admin.users[':uid'].$patch({
    param: { uid },
    json: input
  });
  return unwrapJson<AdminUserMutationResponse>(res);
}
