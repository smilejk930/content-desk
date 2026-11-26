import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { UserRole } from '@content-desk/shared';

declare const USER_SCOPE_BRAND: unique symbol;

/**
 * 요청자 소유 범위 토큰.
 * 인증 미들웨어(firebase-auth.ts 등)에서만 생성해 컨텍스트에 주입하며,
 * 모든 사용자 데이터 리포지토리는 첫 인자로 이 타입을 필수로 받습니다.
 */
export interface UserScope {
  readonly uid: string;
  readonly [USER_SCOPE_BRAND]: true;
}

export interface AuthContext {
  uid: string;
  email: string | null;
  role: UserRole;
  authTime: number;
  issuedAt: number;
  expiresAt: number;
}

export interface WorkerBindings {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  FIREBASE_PROJECT_ID: string;
  ADMIN_UIDS: string;
  ALLOWED_ORIGINS: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  GEMINI_API_KEY?: string;
  SESSION_MAX_AGE_SECONDS: string;
  REAUTH_MAX_AGE_SECONDS: string;
  CLOCK_SKEW_SECONDS: string;
}

export interface WorkerVariables {
  auth: AuthContext;
  userScope: UserScope;
}

export interface WorkerEnv {
  Bindings: WorkerBindings;
  Variables: WorkerVariables;
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseCsvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
