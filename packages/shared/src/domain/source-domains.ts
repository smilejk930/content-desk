export const DEFAULT_PRIMARY_SOURCE_DOMAINS = [
  'go.kr',
  'gov.kr',
  'korea.kr',
  'law.go.kr',
  'ac.kr',
  'or.kr',
  're.kr'
] as const;

export const MAX_SNAPSHOT_BODY_BYTES = 50 * 1024;
export const MAX_AI_PROMPT_EXCERPT_BYTES = 5 * 1024;

export function normalizeDomainPattern(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  let candidate = trimmed;
  if (candidate.includes('://')) {
    try {
      candidate = new URL(candidate).hostname.toLowerCase();
    } catch {
      return '';
    }
  } else {
    candidate = candidate.split('/')[0] ?? '';
    candidate = candidate.split(':')[0] ?? '';
  }
  return candidate.replace(/^\.+|\.+$/g, '');
}

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * 정교한 hostname suffix 일치 검사.
 * - 허용 목록이 'go.kr'일 때 'www.go.kr', 'law.go.kr'는 허용하지만
 *   'evilgo.kr' 또는 'go.kr.evil.com' 같은 사칭 도메인은 차단합니다.
 */
export function findMatchingAllowedDomain(
  hostname: string,
  allowedDomains: readonly string[]
): string | null {
  const normalizedHost = normalizeHostname(hostname);
  if (!normalizedHost) return null;

  for (const rawPattern of allowedDomains) {
    const pattern = normalizeDomainPattern(rawPattern);
    if (!pattern) continue;
    if (normalizedHost === pattern || normalizedHost.endsWith(`.${pattern}`)) {
      return pattern;
    }
  }
  return null;
}

export function buildEffectivePrimarySourceDomains(
  categoryDomains: readonly string[] = []
): string[] {
  const set = new Set<string>();
  for (const domain of [...DEFAULT_PRIMARY_SOURCE_DOMAINS, ...categoryDomains]) {
    const normalized = normalizeDomainPattern(domain);
    if (normalized) set.add(normalized);
  }
  return [...set];
}

export interface PrimarySourceDomainCheck {
  allowed: boolean;
  hostname: string | null;
  matchedDomain: string | null;
}

export function checkPrimarySourceUrlDomain(
  rawUrl: string,
  categoryDomains: readonly string[] = []
): PrimarySourceDomainCheck {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, hostname: null, matchedDomain: null };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, hostname: null, matchedDomain: null };
  }

  const hostname = normalizeHostname(parsed.hostname);
  const effectiveDomains = buildEffectivePrimarySourceDomains(categoryDomains);
  const matchedDomain = findMatchingAllowedDomain(hostname, effectiveDomains);

  return {
    allowed: matchedDomain !== null,
    hostname,
    matchedDomain
  };
}
