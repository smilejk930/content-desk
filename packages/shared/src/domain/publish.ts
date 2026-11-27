const KST_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** Cloudflare R2 무료 저장 용량 한도: 10 GiB */
export const R2_FREE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
/** R2 용량 경고 임계치: 80% (8 GiB) */
export const R2_USAGE_WARN_RATIO = 0.8;
/** 전체 JSON 백업 알림 주기: 30일 */
export const BACKUP_REMINDER_DAYS = 30;
/** 네이버 블로그 ID 허용 형식 (URL 삽입 공격 방지) */
export const NAVER_BLOG_ID_RE = /^[A-Za-z0-9_-]{1,50}$/;

/**
 * 한국 시간(KST, Asia/Seoul) 기준 YYYY-MM-DD 문자열 반환.
 */
export function getKstDateString(now = new Date()): string {
  const parts = KST_DATE_FORMATTER.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/**
 * YYYY-MM-DD 날짜 문자열에 일수를 더하거나 뺀 새 YYYY-MM-DD 반환.
 */
export function addDaysToYmd(ymd: string, days: number): string {
  const [yStr, mStr, dStr] = ymd.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return utc.toISOString().slice(0, 10);
}

/**
 * KST YYYY-MM-DD 자정(00:00:00+09:00)을 UTC ISO 문자열로 변환.
 */
export function kstDateStartToUtcIso(kstYmd: string): string {
  const [yStr, mStr, dStr] = kstYmd.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  // KST is fixed UTC+9 with no DST
  const utcMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 9 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
}

/**
 * KST 기준 현재 주 시작일(월요일, YYYY-MM-DD) 반환.
 */
export function getKstWeekStartDate(now = new Date()): string {
  const today = getKstDateString(now);
  const [yStr, mStr, dStr] = today.split('-');
  const utcDate = new Date(Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr)));
  const dayOfWeek = utcDate.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return addDaysToYmd(today, -daysSinceMonday);
}

/**
 * 네이버 블로그 URL에서 글 번호(logNo) 숫자 세그먼트를 정규화 추출합니다.
 * - 쿼리 파라미터 logNo= (대소문자 무시)
 * - 경로 끝 숫자 세그먼트 (예: /blogId/223456789012)
 * 둘 다 지원하며, 숫자가 없으면 null을 반환합니다.
 */
export function extractNaverLogNo(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  let queryLogNo: string | null = null;
  parsed.searchParams.forEach((value, key) => {
    if (!queryLogNo && key.toLowerCase() === 'logno' && /^[0-9]+$/.test(value.trim())) {
      queryLogNo = value.trim();
    }
  });
  if (queryLogNo) {
    return queryLogNo;
  }

  const segments = parsed.pathname
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last && /^[0-9]+$/.test(last)) {
    return last;
  }

  return null;
}

/**
 * 네이버 블로그 URL에서 블로그 ID(blogId)를 소문자로 정규화 추출합니다.
 * - 쿼리 파라미터 blogId= (대소문자 무시)
 * - blog.naver.com/<blogId>/... 또는 m.blog.naver.com/<blogId>/... 첫 경로 세그먼트
 * 추출할 수 없으면 null을 반환합니다.
 */
export function extractNaverBlogId(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  let queryBlogId: string | null = null;
  parsed.searchParams.forEach((value, key) => {
    if (!queryBlogId && key.toLowerCase() === 'blogid') {
      const candidate = value.trim();
      if (NAVER_BLOG_ID_RE.test(candidate)) {
        queryBlogId = candidate.toLowerCase();
      }
    }
  });
  if (queryBlogId) {
    return queryBlogId;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'blog.naver.com' || host === 'm.blog.naver.com') {
    const segments = parsed.pathname
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const first = segments[0];
    if (
      first &&
      !first.includes('.') &&
      !/^[0-9]+$/.test(first) &&
      NAVER_BLOG_ID_RE.test(first)
    ) {
      return first.toLowerCase();
    }
  }

  return null;
}

/**
 * 네이버 블로그 글쓰기 URL 생성.
 * - 유효한 naver_blog_id가 있으면 https://blog.naver.com/<blogId>/postwrite
 * - 없으면 https://blog.naver.com/GoBlogWrite.naver
 */
export function buildNaverBlogWriteUrl(naverBlogId?: string | null): string {
  const trimmed = naverBlogId?.trim() ?? '';
  if (trimmed && NAVER_BLOG_ID_RE.test(trimmed)) {
    return `https://blog.naver.com/${trimmed}/postwrite`;
  }
  return 'https://blog.naver.com/GoBlogWrite.naver';
}

/**
 * Verified 복사 게이트 단일 판정:
 * approved_hash === content_hash && unresolved_verify_count === 0 일 때만 복사·공유·발행 허용.
 */
export function isManuscriptApprovedForExport(
  manuscript: { content_hash: string; approved_hash: string | null },
  unresolvedVerifyCount: number
): boolean {
  return (
    manuscript.approved_hash !== null &&
    manuscript.approved_hash === manuscript.content_hash &&
    unresolvedVerifyCount === 0
  );
}
