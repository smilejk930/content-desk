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
