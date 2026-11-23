import { createMiddleware } from 'hono/factory';
import { decodeProtectedHeader, importX509, jwtVerify, type CryptoKey } from 'jose';
import type { UserRole } from '@content-desk/shared';
import { parseCsvList, parsePositiveInt, type UserScope, type WorkerEnv } from '../env.js';
import { AppError } from './error-handler.js';

// 운영 바인딩으로 외부 주입할 수 없도록 공식 Google Firebase X.509 인증서 엔드포인트를 고정
const FIREBASE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const UNKNOWN_KID_REFETCH_COOLDOWN_MS = 60_000;

interface CertCacheEntry {
  expiresAtMs: number;
  keys: Map<string, CryptoKey>;
}

let certCache: CertCacheEntry | null = null;
let lastForcedRefetchMs = 0;

export function clearFirebaseCertCacheForTests(): void {
  certCache = null;
  lastForcedRefetchMs = 0;
}

function parseMaxAgeSeconds(cacheControl: string | null): number {
  if (!cacheControl) return 300;
  const match = cacheControl.match(/max-age\s*=\s*(\d+)/i);
  if (!match) return 300;
  const parsed = Number.parseInt(match[1] ?? '300', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
}

async function fetchPublicKeys(nowMs: number): Promise<Map<string, CryptoKey>> {
  const res = await fetch(FIREBASE_CERTS_URL, { method: 'GET' });
  if (!res.ok) {
    throw new AppError(503, 'INTERNAL_ERROR', 'Firebase 공개키 조회에 실패했습니다.');
  }
  const pemMap = (await res.json()) as Record<string, string>;
  const keys = new Map<string, CryptoKey>();
  for (const [kid, pem] of Object.entries(pemMap)) {
    if (typeof pem === 'string' && pem.includes('BEGIN CERTIFICATE')) {
      const key = await importX509(pem, 'RS256');
      keys.set(kid, key);
    }
  }
  const maxAgeSec = parseMaxAgeSeconds(res.headers.get('cache-control'));
  certCache = {
    expiresAtMs: nowMs + maxAgeSec * 1000,
    keys
  };
  return keys;
}

async function resolvePublicKey(kid: string, nowMs: number): Promise<CryptoKey | null> {
  if (certCache && nowMs < certCache.expiresAtMs) {
    const cached = certCache.keys.get(kid);
    if (cached) return cached;

    // 미지 kid로 인한 외부 호출·CPU 소모 공격을 막기 위해 60초 쿨다운 내에서만 최대 1회 재조회
    if (nowMs - lastForcedRefetchMs < UNKNOWN_KID_REFETCH_COOLDOWN_MS) {
      return null;
    }
    lastForcedRefetchMs = nowMs;
    const refreshed = await fetchPublicKeys(nowMs);
    return refreshed.get(kid) ?? null;
  }

  const keys = await fetchPublicKeys(nowMs);
  return keys.get(kid) ?? null;
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export const firebaseAuth = createMiddleware<WorkerEnv>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    throw new AppError(401, 'TOKEN_INVALID', '인증 토큰이 필요합니다.');
  }

  const projectId = c.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) {
    throw new AppError(500, 'INTERNAL_ERROR', 'FIREBASE_PROJECT_ID가 설정되지 않았습니다.');
  }

  let kid: string;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) {
      throw new Error('Invalid JWT header');
    }
    kid = header.kid;
  } catch {
    throw new AppError(401, 'TOKEN_INVALID', '유효하지 않은 인증 토큰 형식입니다.');
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const publicKey = await resolvePublicKey(kid, nowMs);
  if (!publicKey) {
    throw new AppError(401, 'TOKEN_INVALID', '신뢰할 수 있는 서명 키를 찾을 수 없습니다.');
  }

  const clockSkewSec = parsePositiveInt(c.env.CLOCK_SKEW_SECONDS, 60);
  const sessionMaxAgeSec = parsePositiveInt(c.env.SESSION_MAX_AGE_SECONDS, 1209600);
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, publicKey, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: expectedIssuer,
      clockTolerance: clockSkewSec
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    throw new AppError(401, 'TOKEN_INVALID', '인증 토큰 검증에 실패했습니다.');
  }

  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const iat = typeof payload.iat === 'number' ? payload.iat : NaN;
  const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : NaN;
  const exp = typeof payload.exp === 'number' ? payload.exp : NaN;

  if (!sub || !Number.isFinite(iat) || !Number.isFinite(authTime) || !Number.isFinite(exp)) {
    throw new AppError(401, 'TOKEN_INVALID', '필수 인증 클레임이 누락되었습니다.');
  }

  // Reject future iat / auth_time beyond clock skew (60s)
  if (iat > nowSec + clockSkewSec || authTime > nowSec + clockSkewSec) {
    throw new AppError(401, 'TOKEN_INVALID', '인증 토큰 시각이 허용 시계 오차를 초과했습니다.');
  }

  // Enforce 14-day maximum session age
  if (nowSec - authTime > sessionMaxAgeSec) {
    throw new AppError(401, 'SESSION_EXPIRED', '세션이 만료되었습니다. Google 계정으로 다시 로그인해 주세요.');
  }

  // Final defense against unauthorized Google sign-ups:
  // 1) ADMIN_UIDS passes as role='admin' without requiring a users row.
  // 2) Otherwise query D1 users table on EVERY request (no memory cache) so blocks take effect immediately.
  const adminUids = parseCsvList(c.env.ADMIN_UIDS);
  let role: UserRole;

  if (adminUids.includes(sub)) {
    role = 'admin';
  } else {
    const userRow = await c.env.DB.prepare('SELECT status FROM users WHERE uid = ?')
      .bind(sub)
      .first<{ status: string }>();

    if (!userRow) {
      throw new AppError(
        403,
        'USER_NOT_REGISTERED',
        '등록되지 않은 계정입니다. 관리자에게 아래 UID를 전달해 등록을 요청해 주세요.',
        {
          details: { uid: sub }
        }
      );
    }

    if (userRow.status !== 'active') {
      throw new AppError(
        403,
        'USER_BLOCKED',
        '차단된 계정입니다. 접근이 필요하면 관리자에게 문의해 주세요.'
      );
    }

    role = 'user';
  }

  const userScope = { uid: sub } as UserScope;

  c.set('auth', {
    uid: sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    role,
    authTime,
    issuedAt: iat,
    expiresAt: exp
  });
  c.set('userScope', userScope);

  await next();
});
