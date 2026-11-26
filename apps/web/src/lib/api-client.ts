import { hc } from 'hono/client';
import type {
  AdminUserMutationResponse,
  AdminUsersListResponse,
  ApiErrorCode,
  ApiErrorPayload,
  ApproveManuscriptRequest,
  CapturePresignRequest,
  CapturePresignResponse,
  CaptureResponse,
  CapturesListResponse,
  CaptureUploadMime,
  CategoriesListResponse,
  CategoryResponse,
  CreateAdminUserRequest,
  CreateCaptureRequest,
  CreateCategoryRequest,
  CreateSourceSnapshotRequest,
  CreateSourceSnapshotResponse,
  DeleteCategoryResponse,
  DiscoverStep1Request,
  DiscoverStep1Response,
  DiscoverStep2Request,
  DiscoverStep2Response,
  DiscoverStep3Request,
  DiscoverStep3Response,
  ExportResponse,
  GenerateManuscriptRequest,
  LlmConsentRequest,
  ManuscriptDetailResponse,
  ManuscriptResponse,
  ManuscriptsListResponse,
  MeResponse,
  ResolveVerifyRequest,
  TopicFromCaptureRequest,
  TopicResponse,
  TopicsListResponse,
  TopicSourceCandidatesResponse,
  TopicYmylConfirmRequest,
  UpdateAdminUserRequest,
  UpdateCategoryRequest,
  UpdateManuscriptRequest,
  VerifySanitizeResponse
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
      case 'YMYL_BLOCKED':
        return (
          err.message ||
          '의료·건강·금융·투자·법률 등 YMYL 금지 주제는 정책상 등록할 수 없습니다.'
        );
      case 'YMYL_BORDERLINE_CONFIRM_REQUIRED':
        return err.message || 'YMYL 경계 사례입니다. 비YMYL 주제임을 확인한 뒤 재시도해 주세요.';
      case 'YMYL_SECONDARY_UNAVAILABLE':
        return (
          err.message ||
          'YMYL 2차 AI 검사를 수행할 수 없어(API 키 미설정 또는 응답 오류) 통과가 차단되었습니다.'
        );
      case 'SOURCE_DOMAIN_CONFIRM_REQUIRED':
        return err.message || '허용 목록 외 도메인입니다. 공식 출처 여부를 확인한 뒤 저장해 주세요.';
      case 'SSRF_BLOCKED':
        return err.message || '내부 주소 또는 허용되지 않은 URL은 수집할 수 없습니다.';
      case 'ROBOTS_DISALLOWED':
        return err.message || '대상 사이트의 robots.txt 정책에 따라 수집이 차단되었습니다.';
      case 'QUOTA_EXCEEDED':
        return err.message || '전체 사용자 공유 일일 할당량이 소진되었습니다.';
      case 'VERIFY_REQUIRED':
        return err.message || '원고 대조·정제(verify-sanitize) 단계를 먼저 완료해야 승인할 수 있습니다.';
      case 'VERIFY_UNRESOLVED':
        return err.message || '미해소 [VERIFY] 항목이 남아 있어 승인할 수 없습니다.';
      case 'HASH_MISMATCH':
        return err.message || '원고가 수정되어 승인 해시가 일치하지 않습니다. 다시 검토해 주세요.';
      case 'LLM_CONSENT_REQUIRED':
        return err.message || '무료 LLM 제공자 전송 동의가 필요합니다.';
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

export async function fetchCategories(): Promise<CategoriesListResponse> {
  const res = await apiClient.api.categories.$get();
  return unwrapJson<CategoriesListResponse>(res);
}

export async function createCategory(input: CreateCategoryRequest): Promise<CategoryResponse> {
  const res = await apiClient.api.categories.$post({ json: input });
  return unwrapJson<CategoryResponse>(res);
}

export async function updateCategory(
  id: string,
  input: UpdateCategoryRequest
): Promise<CategoryResponse> {
  const res = await apiClient.api.categories[':id'].$patch({
    param: { id },
    json: input
  });
  return unwrapJson<CategoryResponse>(res);
}

export async function deleteCategory(id: string): Promise<DeleteCategoryResponse> {
  const res = await apiClient.api.categories[':id'].$delete({
    param: { id }
  });
  return unwrapJson<DeleteCategoryResponse>(res);
}

export async function presignCaptureUploads(
  input: CapturePresignRequest
): Promise<CapturePresignResponse> {
  const res = await apiClient.api.captures.presign.$post({ json: input });
  return unwrapJson<CapturePresignResponse>(res);
}

export async function fetchCaptures(categoryId?: string): Promise<CapturesListResponse> {
  const res = await apiClient.api.captures.$get({
    query: categoryId ? { category_id: categoryId } : {}
  });
  return unwrapJson<CapturesListResponse>(res);
}

export async function createCapture(input: CreateCaptureRequest): Promise<CaptureResponse> {
  const res = await apiClient.api.captures.$post({ json: input });
  return unwrapJson<CaptureResponse>(res);
}

export async function fetchCapture(id: string): Promise<CaptureResponse> {
  const res = await apiClient.api.captures[':id'].$get({
    param: { id }
  });
  return unwrapJson<CaptureResponse>(res);
}

export async function consentCaptureLlm(
  id: string,
  input: LlmConsentRequest
): Promise<CaptureResponse> {
  const res = await apiClient.api.captures[':id'].consent.$post({
    param: { id },
    json: input
  });
  return unwrapJson<CaptureResponse>(res);
}

// Phase 3: Topics API
export async function fetchTopics(params?: {
  categoryId?: string;
  runId?: string;
  status?: string;
}): Promise<TopicsListResponse> {
  const query: Record<string, string> = {};
  if (params?.categoryId) query.category_id = params.categoryId;
  if (params?.runId) query.run_id = params.runId;
  if (params?.status) query.status = params.status;
  const res = await apiClient.api.topics.$get({ query });
  return unwrapJson<TopicsListResponse>(res);
}

export async function fetchTopic(id: string): Promise<TopicResponse> {
  const res = await apiClient.api.topics[':id'].$get({ param: { id } });
  return unwrapJson<TopicResponse>(res);
}

export async function discoverStep1Seeds(
  input: DiscoverStep1Request
): Promise<DiscoverStep1Response> {
  const res = await apiClient.api.topics.discover['step1-seeds'].$post({ json: input });
  return unwrapJson<DiscoverStep1Response>(res);
}

export async function discoverStep2Datalab(
  input: DiscoverStep2Request
): Promise<DiscoverStep2Response> {
  const res = await apiClient.api.topics.discover['step2-datalab'].$post({ json: input });
  return unwrapJson<DiscoverStep2Response>(res);
}

export async function discoverStep3Supply(
  input: DiscoverStep3Request
): Promise<DiscoverStep3Response> {
  const res = await apiClient.api.topics.discover['step3-supply'].$post({ json: input });
  return unwrapJson<DiscoverStep3Response>(res);
}

export async function createTopicFromCapture(
  input: TopicFromCaptureRequest
): Promise<TopicResponse> {
  const res = await apiClient.api.topics['from-capture'].$post({ json: input });
  return unwrapJson<TopicResponse>(res);
}

export async function confirmTopicYmyl(
  id: string,
  input: TopicYmylConfirmRequest
): Promise<TopicResponse> {
  const res = await apiClient.api.topics[':id']['ymyl-confirm'].$post({
    param: { id },
    json: input
  });
  return unwrapJson<TopicResponse>(res);
}

export async function fetchTopicSourceCandidates(
  id: string
): Promise<TopicSourceCandidatesResponse> {
  const res = await apiClient.api.topics[':id'].sources.candidates.$get({
    param: { id }
  });
  return unwrapJson<TopicSourceCandidatesResponse>(res);
}

export async function createTopicSourceSnapshot(
  id: string,
  input: CreateSourceSnapshotRequest
): Promise<CreateSourceSnapshotResponse> {
  const res = await apiClient.api.topics[':id'].sources.snapshot.$post({
    param: { id },
    json: input
  });
  return unwrapJson<CreateSourceSnapshotResponse>(res);
}

// Phase 3: Manuscripts API
export async function fetchManuscripts(categoryId?: string): Promise<ManuscriptsListResponse> {
  const res = await apiClient.api.manuscripts.$get({
    query: categoryId ? { category_id: categoryId } : {}
  });
  return unwrapJson<ManuscriptsListResponse>(res);
}

export async function generateManuscript(
  input: GenerateManuscriptRequest
): Promise<ManuscriptResponse> {
  const res = await apiClient.api.manuscripts.generate.$post({ json: input });
  return unwrapJson<ManuscriptResponse>(res);
}

export async function verifySanitizeManuscript(id: string): Promise<VerifySanitizeResponse> {
  const res = await apiClient.api.manuscripts[':id']['verify-sanitize'].$post({
    param: { id }
  });
  return unwrapJson<VerifySanitizeResponse>(res);
}

export async function fetchManuscriptDetail(id: string): Promise<ManuscriptDetailResponse> {
  const res = await apiClient.api.manuscripts[':id'].$get({
    param: { id }
  });
  return unwrapJson<ManuscriptDetailResponse>(res);
}

export async function updateManuscript(
  id: string,
  input: UpdateManuscriptRequest
): Promise<ManuscriptResponse> {
  const res = await apiClient.api.manuscripts[':id'].$patch({
    param: { id },
    json: input
  });
  return unwrapJson<ManuscriptResponse>(res);
}

export async function resolveVerifyClaim(
  id: string,
  input: ResolveVerifyRequest
): Promise<ManuscriptResponse> {
  const res = await apiClient.api.manuscripts[':id']['resolve-verify'].$post({
    param: { id },
    json: input
  });
  return unwrapJson<ManuscriptResponse>(res);
}

export async function approveManuscript(
  id: string,
  input: ApproveManuscriptRequest
): Promise<ManuscriptResponse> {
  const res = await apiClient.api.manuscripts[':id'].approve.$post({
    param: { id },
    json: input
  });
  return unwrapJson<ManuscriptResponse>(res);
}

export async function uploadBlobToPresignedUrl(
  uploadUrl: string,
  blob: Blob,
  contentType: CaptureUploadMime,
  expectedByteSize?: number,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (expectedByteSize !== undefined && blob.size !== expectedByteSize) {
    throw new Error(
      `업로드 파일 크기(${blob.size}B)가 서명 요청 크기(${expectedByteSize}B)와 일치하지 않습니다.`
    );
  }
  const res = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType
    },
    body: blob
  });
  if (!res.ok) {
    throw new Error(`R2 이미지 업로드에 실패했습니다 (HTTP ${res.status}).`);
  }
}
