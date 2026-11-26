import type {
  Comment as CfHtmlComment,
  Element as CfHtmlElement,
  HTMLRewriter as CfHtmlRewriter,
  Response as CfResponse
} from '@cloudflare/workers-types';
import {
  sanitizeManuscriptHtml,
  stripHtmlToPlainText,
  type ContentType,
  type ManuscriptClaim
} from '@content-desk/shared';

function createWorkersHtmlRewriter(): CfHtmlRewriter {
  const Ctor = (globalThis as unknown as { HTMLRewriter: new () => CfHtmlRewriter }).HTMLRewriter;
  return new Ctor();
}

const ALLOWED_HTML_TAGS = new Set([
  'p',
  'h2',
  'h3',
  'strong',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
  'br'
]);

const STRIP_ENTIRE_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math'
]);

function normalizeUrlForAllowlist(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Workers 내장 HTMLRewriter 기반 서버 측 허용 목록 HTML 정제:
 * - script/style/iframe/object/embed/svg/math는 내부 콘텐츠까지 완전 제거
 * - 허용 태그(p, h2, h3, strong, ul, ol, li, blockquote, a, br) 외 태그는 태그만 제거
 * - 모든 속성 제거, 단 <a>의 href는 허용된 출처 목록의 http/https URL일 때만 유지
 * - 마지막으로 공용 sanitizeManuscriptHtml을 2중 적용해 방어 심층화
 */
export async function sanitizeHtmlWithWorkersRewriter(
  html: string,
  allowedSourceUrls: readonly string[] = []
): Promise<string> {
  const allowedSet = new Set<string>();
  for (const url of allowedSourceUrls) {
    const normalized = normalizeUrlForAllowlist(url);
    if (normalized) allowedSet.add(normalized);
  }

  const rewriter = createWorkersHtmlRewriter()
    .on('*', {
      element(el: CfHtmlElement) {
        const tag = el.tagName.toLowerCase();
        if (STRIP_ENTIRE_TAGS.has(tag)) {
          el.remove();
          return;
        }
        if (!ALLOWED_HTML_TAGS.has(tag)) {
          el.removeAndKeepContent();
          return;
        }

        let validHref: string | null = null;
        if (tag === 'a') {
          const rawHref = el.getAttribute('href');
          const normalized = rawHref ? normalizeUrlForAllowlist(rawHref) : null;
          if (normalized && allowedSet.has(normalized)) {
            validHref = normalized;
          }
        }

        const attrNames: string[] = [];
        for (const [name] of el.attributes) {
          if (name) attrNames.push(name);
        }
        for (const name of attrNames) {
          el.removeAttribute(name);
        }

        if (tag === 'a') {
          if (validHref) {
            el.setAttribute('href', validHref);
          } else {
            el.removeAndKeepContent();
          }
        }
      },
      comments(comment: CfHtmlComment) {
        comment.remove();
      }
    });

  const wrapped = new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
  const rewritten = await rewriter.transform(wrapped as unknown as CfResponse).text();
  return sanitizeManuscriptHtml(rewritten, allowedSourceUrls);
}

/**
 * 인용구 문자열 대조용 정규화:
 * NFKC + 소문자 + 공백·문장부호·기호(소수점/숫자/% 제외) 제거
 */
export function normalizeForQuoteMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s,·•"'“”‘’()[\]{}?!:;~…—–-]+/gu, '');
}

/**
 * 주장 문장에서 수치·단위 토큰 추출 (가격, 사양 수치, 백분율, 날짜, 배수, 용량 등).
 */
export function extractNumericUnitTokens(text: string): string[] {
  const normalized = text.normalize('NFKC');
  const re =
    /\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:원|만원|억원|달러|%|퍼센트|배|건|회|명|개|장|년|월|일|시간|분|초|ms|s|kb|mb|gb|tb|px|ghz|mhz|mah|w|kw|km|m|cm|mm|kg|g|ml|l))?/gi;
  const matches = normalized.match(re) ?? [];
  return [...new Set(matches.map((m) => m.replace(/[\s,]+/g, '').toLowerCase()))];
}

function quoteContainsAllNumericTokens(claim: string, quote: string): boolean {
  const claimTokens = extractNumericUnitTokens(claim);
  if (claimTokens.length === 0) return true;

  const normalizedQuote = quote
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s,]+/g, '');

  for (const token of claimTokens) {
    if (!normalizedQuote.includes(token)) {
      return false;
    }
  }
  return true;
}

export interface VerifyAndSanitizeResult {
  sanitizedHtml: string;
  claims: ManuscriptClaim[];
  unresolvedVerifyCount: number;
  verifiedClaimCount: number;
  flaggedClaimCount: number;
}

/**
 * 요청 2: 주장–출처 인용구 정규화 대조 + 수치/단위 검증 + Workers HTMLRewriter HTML 정제.
 * - 인용구 누락, 출처 스냅샷(또는 메모) 미존재, 인용구 불일치, 수치/단위 불일치 시
 *   자동으로 VERIFY_REQUIRED로 전환하고 본문에 [VERIFY]를 표기합니다.
 * - explainer 트랙에서는 정제된 본문 평문(사진 마커 제외)에서 추출한 모든 수치·단위 토큰을
 *   검증된 claim의 quote(및 스냅샷)와 대조해 근거 없는 수치가 있으면 claims: []여도 자동 차단합니다.
 */
export async function verifyClaimsAndSanitizeManuscript(params: {
  bodyHtml: string;
  claims: readonly ManuscriptClaim[];
  sourceTexts: ReadonlyMap<string, string>;
  allowedSourceUrls: readonly string[];
  contentType?: ContentType;
}): Promise<VerifyAndSanitizeResult> {
  // 1. Server-side HTML sanitization via Workers HTMLRewriter
  let sanitizedHtml = await sanitizeHtmlWithWorkersRewriter(
    params.bodyHtml,
    params.allowedSourceUrls
  );

  const normalizedSourceMap = new Map<string, string>();
  const combinedSourceCompactTokens = new Set<string>();
  for (const [id, text] of params.sourceTexts.entries()) {
    normalizedSourceMap.set(id, normalizeForQuoteMatch(text));
    for (const tok of extractNumericUnitTokens(text)) {
      combinedSourceCompactTokens.add(tok);
    }
  }

  const verifiedClaims: ManuscriptClaim[] = [];
  let verifiedClaimCount = 0;
  let flaggedClaimCount = 0;

  for (const claim of params.claims) {
    if (claim.verification_status === 'RESOLVED_BY_OWNER') {
      verifiedClaims.push(claim);
      verifiedClaimCount += 1;
      continue;
    }

    const sourceId = claim.source_id?.trim() || null;
    const quote = claim.quote?.trim() || null;
    const normalizedSource = sourceId ? normalizedSourceMap.get(sourceId) : undefined;
    const normalizedQuote = quote ? normalizeForQuoteMatch(quote) : '';

    const quoteFound =
      Boolean(normalizedSource) &&
      normalizedQuote.length >= 2 &&
      normalizedSource!.includes(normalizedQuote);

    const numericMatched = quote ? quoteContainsAllNumericTokens(claim.claim, quote) : false;

    if (quoteFound && numericMatched) {
      verifiedClaims.push({
        ...claim,
        verification_status: 'VERIFIED'
      });
      verifiedClaimCount += 1;
    } else {
      verifiedClaims.push({
        ...claim,
        verification_status: 'VERIFY_REQUIRED'
      });
      flaggedClaimCount += 1;
    }
  }

  // 2. 정제된 본문 평문(사진 마커 제외)에서 추출한 수치·단위 토큰 근거 대조
  const plainBodyWithoutMarkers = stripHtmlToPlainText(sanitizedHtml).replace(
    /\[📷\s*이미지\s*\d+\s*삽입\s*위치\s*:[^\]]+\]/g,
    ''
  );
  const allBodyNumericTokens = extractNumericUnitTokens(plainBodyWithoutMarkers);
  const bodyNumericTokens =
    params.contentType === 'explainer'
      ? allBodyNumericTokens
      : allBodyNumericTokens.filter((tok) => /[a-z가-힣%]/i.test(tok) || tok.length >= 2);

  // 검증된 claim의 quote(및 explainer의 경우 스냅샷 일치)로 근거가 확인된 토큰 집합
  const verifiedQuoteTokens = new Set<string>();
  const alreadyFlaggedTokens = new Set<string>();

  for (const c of verifiedClaims) {
    if (c.verification_status === 'VERIFIED') {
      if (c.quote) {
        for (const tok of extractNumericUnitTokens(c.quote)) {
          verifiedQuoteTokens.add(tok);
        }
      }
    } else if (c.verification_status === 'RESOLVED_BY_OWNER') {
      for (const tok of extractNumericUnitTokens(c.claim)) {
        verifiedQuoteTokens.add(tok);
      }
      if (c.quote) {
        for (const tok of extractNumericUnitTokens(c.quote)) {
          verifiedQuoteTokens.add(tok);
        }
      }
    } else {
      for (const tok of extractNumericUnitTokens(c.claim)) {
        alreadyFlaggedTokens.add(tok);
      }
    }
  }

  const uncoveredTokens = bodyNumericTokens.filter((tok) => {
    if (alreadyFlaggedTokens.has(tok)) return false;
    if (params.contentType === 'explainer') {
      // explainer: 반드시 검증된 claim의 quote AND 스냅샷에 모두 근거가 있어야 통과
      return !(verifiedQuoteTokens.has(tok) && combinedSourceCompactTokens.has(tok));
    }
    return !verifiedQuoteTokens.has(tok);
  });

  if (uncoveredTokens.length > 0) {
    const autoClaim: ManuscriptClaim = {
      claim_id: `auto-num-${crypto.randomUUID().slice(0, 8)}`,
      claim: `출처 대조가 필요한 본문 수치: ${uncoveredTokens.slice(0, 8).join(', ')}`,
      source_id: null,
      quote: null,
      verification_status: 'VERIFY_REQUIRED',
      resolution_url: null
    };
    verifiedClaims.push(autoClaim);
    flaggedClaimCount += 1;
  }

  // 3. 미검증 주장이 1건 이상이면 본문에 [VERIFY] 마커가 반드시 표기되도록 보장
  const unresolvedVerifyCount = verifiedClaims.filter(
    (c) => c.verification_status === 'VERIFY_REQUIRED'
  ).length;

  if (unresolvedVerifyCount > 0 && !sanitizedHtml.includes('[VERIFY]')) {
    const unverifiedTexts = verifiedClaims
      .filter((c) => c.verification_status === 'VERIFY_REQUIRED')
      .map((c) => c.claim);

    let markedInPlace = false;
    for (const claimText of unverifiedTexts) {
      if (claimText.length >= 4 && sanitizedHtml.includes(claimText)) {
        sanitizedHtml = sanitizedHtml.replace(claimText, `${claimText} [VERIFY]`);
        markedInPlace = true;
      }
    }

    if (!markedInPlace) {
      sanitizedHtml = `${sanitizedHtml}<p>[VERIFY] 확인이 필요한 주장이 ${unresolvedVerifyCount}건 있습니다.</p>`;
    }
  }

  sanitizedHtml = sanitizeManuscriptHtml(sanitizedHtml, params.allowedSourceUrls);

  return {
    sanitizedHtml,
    claims: verifiedClaims,
    unresolvedVerifyCount,
    verifiedClaimCount,
    flaggedClaimCount
  };
}
