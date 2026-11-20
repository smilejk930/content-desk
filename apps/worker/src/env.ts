import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface AuthContext {
  uid: string;
  email: string | null;
  authTime: number;
  issuedAt: number;
  expiresAt: number;
}

export interface WorkerBindings {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_UIDS: string;
  ALLOWED_ORIGINS: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  SESSION_MAX_AGE_SECONDS: string;
  REAUTH_MAX_AGE_SECONDS: string;
  CLOCK_SKEW_SECONDS: string;
}

export interface WorkerVariables {
  auth: AuthContext;
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
