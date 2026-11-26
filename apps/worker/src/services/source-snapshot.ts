import type {
  Element as CfHtmlElement,
  HTMLRewriter as CfHtmlRewriter,
  R2Bucket,
  Response as CfResponse,
  Text as CfHtmlText
} from '@cloudflare/workers-types';
import {
  buildEffectivePrimarySourceDomains,
  checkPrimarySourceUrlDomain,
  MAX_AI_PROMPT_EXCERPT_BYTES,
  MAX_SNAPSHOT_BODY_BYTES,
  type PrimarySourceRef
} from '@content-desk/shared';
import type { UserScope } from '../env.js';
import { AppError } from '../middleware/error-handler.js';

function createWorkersHtmlRewriter(): CfHtmlRewriter {
  const Ctor = (globalThis as unknown as { HTMLRewriter: new () => CfHtmlRewriter }).HTMLRewriter;
  return new Ctor();
}

const MAX_REDIRECT_HOPS = 3;
const BOT_USER_AGENT = 'ContentDeskBot';
const ROBOTS_FETCH_TIMEOUT_MS = 5_000;
const SNAPSHOT_FETCH_TIMEOUT_MS = 10_000;
export const MAX_ROBOTS_RESPONSE_BYTES = 512 * 1024;
export const MAX_SNAPSHOT_RESPONSE_BYTES = 1_536 * 1024;

const ALLOWED_SNAPSHOT_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain'
]);

const ALLOWED_ROBOTS_MIME_TYPES = new Set(['text/plain', 'text/html', '']);

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = nums as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0 && (nums[2] === 0 || nums[2] === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function isIpv6LiteralHost(hostname: string): boolean {
  return hostname.includes(':') || hostname.startsWith('[') || hostname.endsWith(']');
}

function isSuspiciousNumericIpHost(hostname: string): boolean {
  if (/^\d+$/.test(hostname)) return true;
  if (/^0x[0-9a-f]+$/i.test(hostname)) return true;
  const parts = hostname.split('.');
  if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) {
    if (parts.length !== 4 || parts.some((p) => p.startsWith('0x') || (p.length > 1 && p.startsWith('0')))) {
      return true;
    }
  }
  return false;
}

/**
 * SSRF 가드:
 * - http/https 외 프로토콜, 자격증명 포함 URL, 비표준 포트(지정 없음·80·443 외),
 *   모든 IPv6 리터럴, localhost/내부 도메인, 사설·루프백·링크로컬·메타데이터 IPv4를 차단합니다.
 */
export function validateUrlForSsrf(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'SSRF_BLOCKED', '유효하지 않은 URL 형식입니다.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(400, 'SSRF_BLOCKED', 'http 또는 https 프로토콜 URL만 수집할 수 있습니다.');
  }

  if (parsed.username || parsed.password) {
    throw new AppError(400, 'SSRF_BLOCKED', '인증 정보가 포함된 URL은 허용되지 않습니다.');
  }

  if (parsed.port !== '' && parsed.port !== '80' && parsed.port !== '443') {
    throw new AppError(
      422,
      'SSRF_BLOCKED',
      `허용되지 않은 포트(${parsed.port})입니다. 기본 포트(80/443)만 수집할 수 있습니다.`
    );
  }

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) {
    throw new AppError(400, 'SSRF_BLOCKED', '호스트명이 비어 있는 URL은 허용되지 않습니다.');
  }

  if (isIpv6LiteralHost(host)) {
    throw new AppError(422, 'SSRF_BLOCKED', 'IPv6 리터럴 주소는 정책상 수집할 수 없습니다.');
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    throw new AppError(422, 'SSRF_BLOCKED', '내부 네트워크 또는 메타데이터 호스트는 수집할 수 없습니다.');
  }

  if (isSuspiciousNumericIpHost(host) || isPrivateOrReservedIpv4(host)) {
    throw new AppError(422, 'SSRF_BLOCKED', '사설 IP·루프백·링크로컬·메타데이터 주소는 수집할 수 없습니다.');
  }

  return parsed;
}

interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * RFC 9309 robots.txt 규칙 매칭:
 * - `*` 와일드카드 및 `$` 끝 앵커 지원
 * - 일반 접두사 일치 지원
 */
function matchesRobotsPattern(pattern: string, targetPathWithQuery: string): boolean {
  if (!pattern) return false;
  const hasEndAnchor = pattern.endsWith('$');
  const rawBody = hasEndAnchor ? pattern.slice(0, -1) : pattern;

  let regexStr = '^';
  for (const ch of rawBody) {
    if (ch === '*') {
      regexStr += '.*';
    } else {
      regexStr += escapeRegexChar(ch);
    }
  }
  if (hasEndAnchor) {
    regexStr += '$';
  }

  return new RegExp(regexStr).test(targetPathWithQuery);
}

export function isPathAllowedByRobotsTxt(robotsTxt: string, targetPathWithQuery: string): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  const starRules: RobotsRule[] = [];
  const botRules: RobotsRule[] = [];

  let activeAgents: string[] = [];
  let seenRuleInGroup = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sepIdx = line.indexOf(':');
    if (sepIdx <= 0) continue;

    const field = line.slice(0, sepIdx).trim().toLowerCase();
    const value = line.slice(sepIdx + 1).trim();

    if (field === 'user-agent') {
      if (seenRuleInGroup) {
        activeAgents = [];
        seenRuleInGroup = false;
      }
      activeAgents.push(value.toLowerCase());
      continue;
    }

    if (field === 'disallow' || field === 'allow') {
      seenRuleInGroup = true;
      if (field === 'disallow' && value === '') {
        continue;
      }
      const rule: RobotsRule = { type: field, path: value };
      if (activeAgents.includes(BOT_USER_AGENT.toLowerCase())) {
        botRules.push(rule);
      }
      if (activeAgents.includes('*')) {
        starRules.push(rule);
      }
    }
  }

  const applicable = botRules.length > 0 ? botRules : starRules;
  if (applicable.length === 0) return true;

  let bestMatch: RobotsRule | null = null;
  for (const rule of applicable) {
    if (!rule.path.startsWith('/')) continue;
    if (matchesRobotsPattern(rule.path, targetPathWithQuery)) {
      if (
        !bestMatch ||
        rule.path.length > bestMatch.path.length ||
        (rule.path.length === bestMatch.path.length && rule.type === 'allow')
      ) {
        bestMatch = rule;
      }
    }
  }

  return bestMatch ? bestMatch.type === 'allow' : true;
}

function normalizeMimeType(contentTypeHeader: string | null): string {
  if (!contentTypeHeader) return '';
  return contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';
}

function assertAllowedContentType(
  response: Response,
  allowedMimes: ReadonlySet<string>,
  errorCode: 'VALIDATION_ERROR' | 'ROBOTS_DISALLOWED',
  label: string
): void {
  const mime = normalizeMimeType(response.headers.get('content-type'));
  if (!allowedMimes.has(mime)) {
    throw new AppError(
      422,
      errorCode,
      `${label}의 Content-Type(${mime || '미지정'})은 허용되지 않습니다.`
    );
  }
}

/**
 * Content-Length 사전 확인 + ReadableStream reader 누적 바이트 검사로
 * 상한 초과 시 즉시 reader.cancel()을 호출해 메모리 과다 버퍼링을 차단합니다.
 */
async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  errorCode: 'VALIDATION_ERROR' | 'ROBOTS_DISALLOWED',
  label: string
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLengthRaw = response.headers.get('content-length');
  if (contentLengthRaw) {
    const contentLength = Number.parseInt(contentLengthRaw, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError(
        422,
        errorCode,
        `${label} 응답 크기(${contentLength}B)가 허용 상한(${maxBytes}B)을 초과하여 중단했습니다.`
      );
    }
  }

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new AppError(
        422,
        errorCode,
        `${label} 응답 크기가 허용 상한(${maxBytes}B)을 초과하여 중단했습니다.`
      );
    }
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('Response exceeded maximum allowed byte limit');
        throw new AppError(
          422,
          errorCode,
          `${label} 스트림 크기가 허용 상한(${maxBytes}B)을 초과하여 즉시 중단했습니다.`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(new ArrayBuffer(totalBytes));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function assertDomainAllowedOrThrow(
  url: URL,
  categoryAllowedDomains: readonly string[],
  confirmUnlistedDomain: boolean
): void {
  const domainCheck = checkPrimarySourceUrlDomain(url.toString(), categoryAllowedDomains);
  if (!domainCheck.allowed && !confirmUnlistedDomain) {
    const effectiveDomains = buildEffectivePrimarySourceDomains(categoryAllowedDomains);
    throw new AppError(
      409,
      'SOURCE_DOMAIN_CONFIRM_REQUIRED',
      `도메인(${url.hostname})은 허용된 1차 출처 도메인 목록에 없습니다. 공식 출처 여부를 확인한 뒤 다시 저장해 주세요.`,
      {
        details: {
          url: url.toString(),
          hostname: url.hostname,
          allowed_domains: effectiveDomains,
          confirm_field: 'confirm_unlisted_domain'
        }
      }
    );
  }
}

async function fetchWithSafeRedirects(
  initialUrl: URL,
  options: {
    accept: string;
    timeoutMs: number;
    onHopUrl?: (hopUrl: URL) => void;
  }
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    validateUrlForSsrf(currentUrl.toString());
    options.onHopUrl?.(currentUrl);

    const res = await fetch(currentUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        'User-Agent': `${BOT_USER_AGENT}/1.0`,
        Accept: options.accept
      }
    });

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location || hop === MAX_REDIRECT_HOPS) {
        throw new AppError(
          422,
          'SSRF_BLOCKED',
          '허용된 리다이렉트 횟수를 초과했거나 대상이 올바르지 않습니다.'
        );
      }
      currentUrl = validateUrlForSsrf(new URL(location, currentUrl).toString());
      continue;
    }

    return { response: res, finalUrl: currentUrl };
  }

  throw new AppError(422, 'SSRF_BLOCKED', '안전한 리다이렉트 처리에 실패했습니다.');
}

/**
 * RFC 9309 준수 robots.txt 검사:
 * - 안전 리다이렉트(301/302 http→https, apex→www 등 매 hop SSRF 검증) 지원
 * - 404/410 미존재 시에만 허용; 5xx/네트워크 오류/타임아웃/바이너리 응답은 보수 차단(422 ROBOTS_DISALLOWED)
 * - 512KB 상한 스트림 cancel + 와일드카드(*)/끝 앵커($) 최장 일치 적용
 */
export async function assertRobotsTxtAllowed(targetUrl: URL): Promise<void> {
  const robotsUrl = new URL('/robots.txt', targetUrl.origin);
  validateUrlForSsrf(robotsUrl.toString());

  let response: Response;
  try {
    const fetched = await fetchWithSafeRedirects(robotsUrl, {
      accept: 'text/plain, */*;q=0.1',
      timeoutMs: ROBOTS_FETCH_TIMEOUT_MS
    });
    response = fetched.response;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      422,
      'ROBOTS_DISALLOWED',
      `대상 사이트(${targetUrl.hostname})의 robots.txt 확인 중 네트워크 오류 또는 타임아웃이 발생해 수집을 차단했습니다.`
    );
  }

  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError(
      422,
      'ROBOTS_DISALLOWED',
      `대상 사이트(${targetUrl.hostname})의 robots.txt 응답 오류(HTTP ${response.status})로 수집을 차단했습니다.`
    );
  }

  assertAllowedContentType(response, ALLOWED_ROBOTS_MIME_TYPES, 'ROBOTS_DISALLOWED', 'robots.txt');
  const bytes = await readResponseBytesWithLimit(
    response,
    MAX_ROBOTS_RESPONSE_BYTES,
    'ROBOTS_DISALLOWED',
    'robots.txt'
  );

  const robotsBody = new TextDecoder('utf-8').decode(bytes);
  const pathWithQuery = `${targetUrl.pathname}${targetUrl.search}`;
  if (!isPathAllowedByRobotsTxt(robotsBody, pathWithQuery)) {
    throw new AppError(
      422,
      'ROBOTS_DISALLOWED',
      `대상 사이트(${targetUrl.hostname})의 robots.txt Disallow 정책에 따라 본문 수집이 차단되었습니다.`
    );
  }
}

export function truncateTextToUtf8Bytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) {
    return text;
  }
  const sliced = encoded.slice(0, maxBytes);
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(sliced).replace(/\uFFFD+$/, '').trimEnd();
}

export async function computeSha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Workers 내장 HTMLRewriter로 DOM 파싱 없이 본문 텍스트만 스트리밍 추출하고
 * UTF-8 최대 50KB 상한으로 절단합니다.
 */
export async function extractBodyTextWithHtmlRewriter(
  response: Response,
  maxBytes = MAX_SNAPSHOT_BODY_BYTES
): Promise<string> {
  const mime = normalizeMimeType(response.headers.get('content-type'));
  if (mime === 'text/plain') {
    const raw = await response.text();
    const normalized = raw.replace(/\r\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    return truncateTextToUtf8Bytes(normalized, maxBytes);
  }

  const chunks: string[] = [];
  let approxBytes = 0;
  const maxBufferBytes = maxBytes * 2;
  let insideIgnoredDepth = 0;
  const encoder = new TextEncoder();

  const ignoredSelector = 'script, style, noscript, iframe, svg, nav, header, footer, template, form';

  const rewriter = createWorkersHtmlRewriter()
    .on(ignoredSelector, {
      element(el: CfHtmlElement) {
        insideIgnoredDepth += 1;
        el.onEndTag(() => {
          insideIgnoredDepth = Math.max(0, insideIgnoredDepth - 1);
        });
        el.remove();
      }
    })
    .on('p, h1, h2, h3, h4, li, td, th, blockquote, pre, article, section, div, br', {
      element() {
        if (insideIgnoredDepth === 0 && approxBytes < maxBufferBytes) {
          chunks.push('\n');
          approxBytes += 1;
        }
      }
    })
    .on('*', {
      text(text: CfHtmlText) {
        if (insideIgnoredDepth > 0 || approxBytes >= maxBufferBytes) return;
        const segment = text.text;
        if (!segment) return;
        chunks.push(segment);
        approxBytes += encoder.encode(segment).byteLength;
      }
    });

  const transformed = rewriter.transform(response as unknown as CfResponse);
  await transformed.arrayBuffer();

  const normalized = chunks
    .join('')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return truncateTextToUtf8Bytes(normalized, maxBytes);
}

export function buildSnapshotObjectKey(
  scope: UserScope,
  topicId: string,
  snapshotId: string
): string {
  return `users/${scope.uid}/snapshots/${topicId}/${snapshotId}.txt`;
}

export interface CollectedSnapshotResult {
  snapshotRef: PrimarySourceRef & { char_count: number };
  bodyText: string;
  excerpt: string;
}

export async function collectAndStorePrimarySourceSnapshot(params: {
  scope: UserScope;
  bucket: R2Bucket;
  topicId: string;
  url: string;
  ingestChannel: 'webkr_search' | 'manual_input';
  categoryAllowedDomains: readonly string[];
  confirmUnlistedDomain: boolean;
  now?: Date;
}): Promise<CollectedSnapshotResult> {
  const now = params.now ?? new Date();

  // 1. SSRF Guard first
  const parsedUrl = validateUrlForSsrf(params.url);

  // 2. Domain allowlist check on initial URL
  assertDomainAllowedOrThrow(
    parsedUrl,
    params.categoryAllowedDomains,
    params.confirmUnlistedDomain
  );

  // 3. Initial robots.txt compliance check
  await assertRobotsTxtAllowed(parsedUrl);

  // 4. Safe fetch with SSRF + Domain allowlist verification on EVERY redirect hop
  let response: Response;
  let finalUrl: URL;
  try {
    const fetched = await fetchWithSafeRedirects(parsedUrl, {
      accept: 'text/html, application/xhtml+xml, text/plain;q=0.9',
      timeoutMs: SNAPSHOT_FETCH_TIMEOUT_MS,
      onHopUrl: (hopUrl) => {
        assertDomainAllowedOrThrow(
          hopUrl,
          params.categoryAllowedDomains,
          params.confirmUnlistedDomain
        );
      }
    });
    response = fetched.response;
    finalUrl = fetched.finalUrl;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      502,
      'UPSTREAM_API_ERROR',
      '1차 출처 페이지 요청 중 네트워크 오류 또는 타임아웃이 발생했습니다.'
    );
  }

  // Final URL domain allowlist re-check
  assertDomainAllowedOrThrow(
    finalUrl,
    params.categoryAllowedDomains,
    params.confirmUnlistedDomain
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError(
      502,
      'UPSTREAM_API_ERROR',
      `1차 출처 페이지를 불러오지 못했습니다 (HTTP ${response.status}).`
    );
  }

  // Re-verify robots.txt whenever redirected (different origin OR different pathname/query)
  if (
    finalUrl.origin !== parsedUrl.origin ||
    finalUrl.pathname !== parsedUrl.pathname ||
    finalUrl.search !== parsedUrl.search
  ) {
    await assertRobotsTxtAllowed(finalUrl);
  }

  // 5. Content-Type allowlist + bounded stream read (<= 1.5MB, cancel() immediately if exceeded)
  assertAllowedContentType(response, ALLOWED_SNAPSHOT_MIME_TYPES, 'VALIDATION_ERROR', '1차 출처 본문');
  const rawBytes = await readResponseBytesWithLimit(
    response,
    MAX_SNAPSHOT_RESPONSE_BYTES,
    'VALIDATION_ERROR',
    '1차 출처 본문'
  );

  const boundedResponse = new Response(rawBytes, {
    headers: {
      'content-type': response.headers.get('content-type') ?? 'text/html; charset=utf-8'
    }
  });

  // 6. Stream body extraction with Workers HTMLRewriter + 50KB UTF-8 limit
  const bodyText = await extractBodyTextWithHtmlRewriter(boundedResponse, MAX_SNAPSHOT_BODY_BYTES);
  if (bodyText.trim().length === 0) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      '해당 페이지에서 추출할 수 있는 본문 텍스트가 없습니다.'
    );
  }

  const snapshotId = crypto.randomUUID();
  const r2Key = buildSnapshotObjectKey(params.scope, params.topicId, snapshotId);
  const bodySha256 = await computeSha256Hex(bodyText);
  const encodedBody = new TextEncoder().encode(bodyText);

  await params.bucket.put(r2Key, encodedBody, {
    httpMetadata: {
      contentType: 'text/plain; charset=utf-8'
    }
  });

  const excerpt = truncateTextToUtf8Bytes(bodyText, MAX_AI_PROMPT_EXCERPT_BYTES);

  return {
    snapshotRef: {
      source_id: snapshotId,
      url: finalUrl.toString(),
      domain: finalUrl.hostname.toLowerCase(),
      r2_key: r2Key,
      fetched_at: now.toISOString(),
      body_sha256: bodySha256,
      ingest_channel: params.ingestChannel,
      char_count: bodyText.length
    },
    bodyText,
    excerpt
  };
}
