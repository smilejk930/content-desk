export interface ProductionApiGuardEnv {
  cfPages?: string;
  requireApiBaseUrl?: string;
}

export interface ProductionApiGuardResult {
  strict: boolean;
  valid: boolean;
  apiOrigin: string | null;
  warning: string | null;
}

/**
 * VITE_API_BASE_URL 정규화: 앞뒤 공백 및 끝 슬래시(/) 반복 제거.
 * api-client.ts와 빌드 가드(csp.ts)가 동일한 정규화 기준을 공유합니다.
 */
export function normalizeApiBaseUrl(raw?: string): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

/**
 * 프로덕션 빌드(Cloudflare Pages 또는 REQUIRE_API_BASE_URL=true) 시
 * VITE_API_BASE_URL이 유효한 https:// URL인지 검증합니다.
 * - strict 모드에서 비어 있거나 유효한 https:// URL이 아니면 Error를 throw해 빌드를 중단합니다.
 * - 로컬 빌드에서는 warning만 반환하고 통과합니다.
 */
export function validateProductionApiBaseUrl(
  apiBaseUrl: string,
  envFlags: ProductionApiGuardEnv = {}
): ProductionApiGuardResult {
  const strict = envFlags.cfPages === '1' || envFlags.requireApiBaseUrl === 'true';
  const trimmed = apiBaseUrl.trim();

  if (!trimmed) {
    if (strict) {
      throw new Error(
        '[Content Desk Build Guard] 프로덕션 빌드(CF_PAGES=1 또는 REQUIRE_API_BASE_URL=true)에는 ' +
          '유효한 https:// VITE_API_BASE_URL 환경 변수가 필수입니다.'
      );
    }
    return {
      strict: false,
      valid: false,
      apiOrigin: null,
      warning:
        '[Content Desk Build Guard] VITE_API_BASE_URL이 비어 있습니다. 로컬 프록시 전용 빌드입니다.'
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    if (strict) {
      throw new Error(
        `[Content Desk Build Guard] VITE_API_BASE_URL이 유효한 URL 형식이 아닙니다: "${trimmed}"`
      );
    }
    return {
      strict: false,
      valid: false,
      apiOrigin: null,
      warning: `[Content Desk Build Guard] VITE_API_BASE_URL 형식을 확인해 주세요: "${trimmed}"`
    };
  }

  if (parsed.protocol !== 'https:') {
    if (strict) {
      throw new Error(
        `[Content Desk Build Guard] 프로덕션 빌드의 VITE_API_BASE_URL은 반드시 https:// 스킴이어야 합니다: "${trimmed}"`
      );
    }
    return {
      strict: false,
      valid: false,
      apiOrigin: parsed.origin,
      warning: `[Content Desk Build Guard] VITE_API_BASE_URL이 https://가 아닙니다: "${trimmed}"`
    };
  }

  return {
    strict,
    valid: true,
    apiOrigin: parsed.origin,
    warning: null
  };
}

export function injectApiOriginIntoHeaders(headersContent: string, apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim();
  if (!trimmed) return headersContent;

  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`VITE_API_BASE_URL은 http(s) URL이어야 합니다: ${trimmed}`);
  }
  const apiOrigin = parsed.origin;

  if (!headersContent.includes("connect-src 'self'")) {
    throw new Error('_headers에 connect-src 지시어가 없습니다.');
  }
  if (headersContent.includes(apiOrigin)) {
    return headersContent;
  }
  return headersContent.replace("connect-src 'self'", `connect-src 'self' ${apiOrigin}`);
}
