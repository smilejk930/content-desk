import type { D1Database } from '@cloudflare/workers-types';
import type { SerpSnippetItem } from '@content-desk/shared';
import type { WorkerBindings } from '../env.js';
import { AppError } from '../middleware/error-handler.js';
import { getApiCacheEntry, upsertApiCacheEntry } from '../repositories/quota.repo.js';
import { reserveProviderQuota, settleSingleProviderQuota } from './quota-ledger.js';

const NAVER_SEARCH_BASE = 'https://openapi.naver.com/v1/search';
const NAVER_DATALAB_URL = 'https://openapi.naver.com/v1/datalab/search';
const NAVER_SEARCHAD_BASE = 'https://api.searchad.naver.com';
const GOOGLE_TRENDS_RSS_URL = 'https://trends.google.com/trending/rss?geo=KR';

const DATALAB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GOOGLE_TRENDS_CACHE_TTL_MS = 60 * 60 * 1000;
const GOOGLE_TRENDS_BASE_BACKOFF_MS = 15 * 60 * 1000;
const GOOGLE_TRENDS_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export interface NaverSearchResultItem {
  title: string;
  link: string;
  description: string;
}

export interface NaverSearchResult {
  total: number;
  items: NaverSearchResultItem[];
}

function stripNaverHtml(raw: string): string {
  return raw
    .replace(/<\/?b>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function requireNaverOpenApiCreds(env: WorkerBindings): { clientId: string; clientSecret: string } {
  const clientId = env.NAVER_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.NAVER_CLIENT_SECRET?.trim() ?? '';
  if (!clientId || !clientSecret) {
    throw new AppError(
      503,
      'UPSTREAM_API_ERROR',
      'NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET이 설정되지 않았습니다.'
    );
  }
  return { clientId, clientSecret };
}

export async function searchNaver(
  env: WorkerBindings,
  ownerUid: string,
  kind: 'blog' | 'news' | 'webkr',
  query: string,
  options?: { display?: number; sort?: 'sim' | 'date'; now?: Date }
): Promise<NaverSearchResult> {
  const creds = requireNaverOpenApiCreds(env);
  const now = options?.now ?? new Date();
  const display = Math.min(Math.max(options?.display ?? 10, 1), 100);

  const reservation = await reserveProviderQuota(env.DB, {
    provider: 'naver_search',
    amount: 1,
    now
  });

  let actualUsed = 0;
  try {
    const url = new URL(`${NAVER_SEARCH_BASE}/${kind}.json`);
    url.searchParams.set('query', query);
    url.searchParams.set('display', String(display));
    if (options?.sort && kind !== 'webkr') {
      url.searchParams.set('sort', options.sort);
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-Naver-Client-Id': creds.clientId,
        'X-Naver-Client-Secret': creds.clientSecret
      }
    });

    if (!res.ok) {
      throw new AppError(
        502,
        'UPSTREAM_API_ERROR',
        `네이버 검색 API(${kind}) 호출이 실패했습니다 (HTTP ${res.status}).`
      );
    }

    // res.ok 확인 이후에만 actualUsed를 누적해 4xx/5xx 실패가 usage_daily에 쌓이지 않게 함
    actualUsed = 1;

    const json = (await res.json()) as {
      total?: number;
      items?: Array<{ title?: string; link?: string; description?: string }>;
    };

    const items: NaverSearchResultItem[] = (json.items ?? [])
      .filter((item) => typeof item.link === 'string' && item.link.length > 0)
      .map((item) => ({
        title: stripNaverHtml(item.title ?? ''),
        link: item.link ?? '',
        description: stripNaverHtml(item.description ?? '')
      }));

    return {
      total: typeof json.total === 'number' && Number.isFinite(json.total) ? json.total : 0,
      items
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'UPSTREAM_API_ERROR', `네이버 검색 API(${kind}) 네트워크 오류가 발생했습니다.`);
  } finally {
    await settleSingleProviderQuota(env.DB, {
      ownerUid,
      reservation,
      actualUsed,
      d1Reads: 0,
      d1Writes: 0,
      now
    });
  }
}

export interface DataLabNormalizedResult {
  scores: Map<string, number>;
  cacheHits: number;
  apiCalls: number;
}

function buildDatalabCacheKey(anchor: string, keyword: string): string {
  return `naver_datalab:v1:${anchor.trim().toLowerCase()}::${keyword.trim().toLowerCase()}`;
}

function formatDateYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 네이버 데이터랩 배치 정규화 호출:
 * - 항상 datalab_anchor_keyword를 기준 그룹(1개)으로 포함하고 최대 4개 후보(총 5개 keywordGroups)씩 배치 호출
 * - 결과를 24시간 이상 D1 api_cache에 캐시해 재호출 비용을 절감
 */
export async function fetchNormalizedDatalabScores(
  env: WorkerBindings,
  ownerUid: string,
  anchorKeyword: string,
  keywords: readonly string[],
  now = new Date()
): Promise<DataLabNormalizedResult> {
  const uniqueKeywords = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length > 0))];
  const scores = new Map<string, number>();
  const uncached: string[] = [];
  let cacheHits = 0;
  let apiCalls = 0;

  for (const kw of uniqueKeywords) {
    const cacheKey = buildDatalabCacheKey(anchorKeyword, kw);
    const cached = await getApiCacheEntry(env.DB, cacheKey);
    if (cached && Date.parse(cached.expires_at) > now.getTime()) {
      try {
        const payload = JSON.parse(cached.payload_json) as { normalizedIndex?: number };
        if (typeof payload.normalizedIndex === 'number' && Number.isFinite(payload.normalizedIndex)) {
          scores.set(kw, payload.normalizedIndex);
          cacheHits += 1;
          continue;
        }
      } catch {
        // Ignore corrupt cache
      }
    }
    uncached.push(kw);
  }

  if (uncached.length === 0) {
    return { scores, cacheHits, apiCalls };
  }

  const creds = requireNaverOpenApiCreds(env);
  const batches: string[][] = [];
  for (let i = 0; i < uncached.length; i += 4) {
    batches.push(uncached.slice(i, i + 4));
  }

  const reservation = await reserveProviderQuota(env.DB, {
    provider: 'naver_datalab',
    amount: batches.length,
    now
  });

  const endDate = formatDateYmd(now);
  const startDateObj = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startDate = formatDateYmd(startDateObj);
  const expiresAtIso = new Date(now.getTime() + DATALAB_CACHE_TTL_MS).toISOString();

  try {
    for (const batch of batches) {
      const keywordGroups = [
        { groupName: '__anchor__', keywords: [anchorKeyword] },
        ...batch.map((kw) => ({ groupName: kw, keywords: [kw] }))
      ];

      const res = await fetch(NAVER_DATALAB_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Naver-Client-Id': creds.clientId,
          'X-Naver-Client-Secret': creds.clientSecret
        },
        body: JSON.stringify({
          startDate,
          endDate,
          timeUnit: 'week',
          keywordGroups
        })
      });

      if (!res.ok) {
        throw new AppError(
          502,
          'UPSTREAM_API_ERROR',
          `네이버 데이터랩 API 호출이 실패했습니다 (HTTP ${res.status}).`
        );
      }

      // res.ok 확인 이후에만 성공 호출 수(actualUsed)를 누적
      apiCalls += 1;

      const json = (await res.json()) as {
        results?: Array<{ title?: string; data?: Array<{ ratio?: number }> }>;
      };

      const avgByTitle = new Map<string, number>();
      for (const entry of json.results ?? []) {
        const title = entry.title ?? '';
        const ratios = (entry.data ?? [])
          .map((d) => (typeof d.ratio === 'number' ? d.ratio : 0))
          .filter((r) => Number.isFinite(r));
        const avg = ratios.length > 0 ? ratios.reduce((sum, v) => sum + v, 0) / ratios.length : 0;
        avgByTitle.set(title, avg);
      }

      const anchorAvg = avgByTitle.get('__anchor__') ?? 0;

      for (const kw of batch) {
        const kwAvg = avgByTitle.get(kw) ?? 0;
        const normalizedIndex =
          anchorAvg > 0
            ? Number(((kwAvg / anchorAvg) * 100).toFixed(2))
            : Number(kwAvg.toFixed(2));
        scores.set(kw, normalizedIndex);

        await upsertApiCacheEntry(env.DB, {
          cacheKey: buildDatalabCacheKey(anchorKeyword, kw),
          payloadJson: JSON.stringify({
            anchor: anchorKeyword,
            keyword: kw,
            normalizedIndex,
            cachedAt: now.toISOString()
          }),
          expiresAtIso,
          backoffUntilIso: null
        });
      }
    }
  } finally {
    await settleSingleProviderQuota(env.DB, {
      ownerUid,
      reservation,
      actualUsed: apiCalls,
      d1Reads: uniqueKeywords.length,
      d1Writes: uncached.length,
      now
    });
  }

  return { scores, cacheHits, apiCalls };
}

async function computeSearchAdHmacBase64(secretKey: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sigBuffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function parseSearchAdVolume(raw: number | string | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.round(raw));
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('<')) return 5;
    const parsed = Number.parseInt(trimmed.replace(/,/g, ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}

export interface SearchAdStatsResult {
  used: boolean;
  monthlyVolumes: Map<string, number>;
  warnings: string[];
}

/**
 * 선택형 네이버 검색광고 API (/keywordstool, WebCrypto HMAC-SHA256 서명).
 * - 키 3종이 모두 설정된 경우에만 호출하며, 미설정 시 우회합니다.
 * - HTTP 오류(예: 401)나 네트워크 예외가 발생해도 step3-supply 전체가 500이 되지 않도록
 *   경고를 남기고 건너뛰며, 성공 응답이 1건도 없을 때는 used: false를 반환합니다.
 */
export async function fetchOptionalSearchAdVolumes(
  env: WorkerBindings,
  ownerUid: string,
  keywords: readonly string[],
  now = new Date()
): Promise<SearchAdStatsResult> {
  const apiKey = env.NAVER_SEARCHAD_API_KEY?.trim() ?? '';
  const secretKey = env.NAVER_SEARCHAD_SECRET_KEY?.trim() ?? '';
  const customerId = env.NAVER_SEARCHAD_CUSTOMER_ID?.trim() ?? '';

  if (!apiKey || !secretKey || !customerId) {
    return { used: false, monthlyVolumes: new Map(), warnings: [] };
  }

  const cleaned = [...new Set(keywords.map((k) => k.replace(/\s+/g, '')).filter((k) => k.length > 0))];
  if (cleaned.length === 0) {
    return { used: false, monthlyVolumes: new Map(), warnings: [] };
  }

  const batches: string[][] = [];
  for (let i = 0; i < cleaned.length; i += 5) {
    batches.push(cleaned.slice(i, i + 5));
  }

  const reservation = await reserveProviderQuota(env.DB, {
    provider: 'naver_searchad',
    amount: batches.length,
    now
  });

  const monthlyVolumes = new Map<string, number>();
  const warnings: string[] = [];
  let actualUsed = 0;

  try {
    for (const batch of batches) {
      try {
        const timestamp = String(now.getTime());
        const uri = '/keywordstool';
        const signature = await computeSearchAdHmacBase64(secretKey, `${timestamp}.GET.${uri}`);
        const url = new URL(`${NAVER_SEARCHAD_BASE}${uri}`);
        url.searchParams.set('hintKeywords', batch.join(','));
        url.searchParams.set('showDetail', '1');

        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'X-Timestamp': timestamp,
            'X-API-KEY': apiKey,
            'X-Customer': customerId,
            'X-Signature': signature
          }
        });

        if (!res.ok) {
          const msg = `네이버 검색광고 API 응답 오류(HTTP ${res.status})로 해당 배치를 건너뜁니다.`;
          warnings.push(msg);
          console.warn(`[naver-searchad] ${msg}`);
          continue;
        }

        const json = (await res.json()) as {
          keywordList?: Array<{
            relKeyword?: string;
            monthlyPcQcCnt?: number | string;
            monthlyMobileQcCnt?: number | string;
          }>;
        };

        // res.ok 및 JSON 파싱 성공 이후에만 actualUsed를 증가
        actualUsed += 1;

        for (const item of json.keywordList ?? []) {
          const rel = item.relKeyword?.trim().toLowerCase();
          if (!rel) continue;
          const total =
            parseSearchAdVolume(item.monthlyPcQcCnt) + parseSearchAdVolume(item.monthlyMobileQcCnt);
          monthlyVolumes.set(rel, total);
        }
      } catch (err) {
        const msg = `네이버 검색광고 API 네트워크/파싱 예외로 해당 배치를 건너뜁니다: ${
          err instanceof Error ? err.message : 'unknown'
        }`;
        warnings.push(msg);
        console.warn(`[naver-searchad] ${msg}`);
      }
    }
  } finally {
    await settleSingleProviderQuota(env.DB, {
      ownerUid,
      reservation,
      actualUsed,
      d1Reads: 0,
      d1Writes: 0,
      now
    });
  }

  return { used: actualUsed > 0, monthlyVolumes, warnings };
}

export interface GoogleTrendsResult {
  status: 'ok' | 'cached' | 'backoff_skipped' | 'error_skipped';
  keywords: string[];
}

function extractRssTitles(xml: string, limit = 10): string[] {
  const results: string[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null && results.length < limit) {
    const block = match[1] ?? '';
    const titleMatch = block.match(/<title\b[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const title = stripNaverHtml(titleMatch?.[1] ?? '');
    if (title.length > 0 && !results.includes(title)) {
      results.push(title);
    }
  }
  return results;
}

/**
 * Google Trends RSS 보조 시드 수집:
 * - 의도적 설계: Google Trends RSS는 API 키나 유료 일일 한도가 없는 무료 공개 피드이므로
 *   전역 quota_ledger 카운터에 적재하지 않고, D1 api_cache의 캐시 TTL(1시간)과
 *   backoff_until 지수 백오프(15분~6시간)로만 과호출 및 공용 IP 429 차단을 보호합니다.
 * - 429 차단 시 같은 요청에서 대기하지 않고 지수 백오프를 기록한 뒤 캐시/빈 목록으로 폴백해
 *   네이버 발굴 파이프라인이 중단되지 않게 합니다.
 */
export async function fetchGoogleTrendsSeeds(
  db: D1Database,
  now = new Date()
): Promise<GoogleTrendsResult> {
  const cacheKey = 'google_trends_rss:KR';
  const cached = await getApiCacheEntry(db, cacheKey);

  let cachedKeywords: string[] = [];
  let prevBackoffCount = 0;
  if (cached) {
    try {
      const parsed = JSON.parse(cached.payload_json) as {
        keywords?: string[];
        backoffCount?: number;
      };
      if (Array.isArray(parsed.keywords)) {
        cachedKeywords = parsed.keywords.filter((k) => typeof k === 'string');
      }
      if (typeof parsed.backoffCount === 'number' && Number.isFinite(parsed.backoffCount)) {
        prevBackoffCount = parsed.backoffCount;
      }
    } catch {
      // Ignore corrupt cache
    }

    if (cached.backoff_until && Date.parse(cached.backoff_until) > now.getTime()) {
      return { status: 'backoff_skipped', keywords: cachedKeywords };
    }

    if (Date.parse(cached.expires_at) > now.getTime() && cachedKeywords.length > 0) {
      return { status: 'cached', keywords: cachedKeywords };
    }
  }

  try {
    const res = await fetch(GOOGLE_TRENDS_RSS_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml'
      }
    });

    if (res.status === 429 || res.status >= 500) {
      const nextCount = Math.min(prevBackoffCount + 1, 6);
      const backoffMs = Math.min(
        GOOGLE_TRENDS_BASE_BACKOFF_MS * Math.pow(2, nextCount - 1),
        GOOGLE_TRENDS_MAX_BACKOFF_MS
      );
      const backoffUntilIso = new Date(now.getTime() + backoffMs).toISOString();
      await upsertApiCacheEntry(db, {
        cacheKey,
        payloadJson: JSON.stringify({
          keywords: cachedKeywords,
          backoffCount: nextCount,
          lastErrorStatus: res.status
        }),
        expiresAtIso: cached?.expires_at ?? now.toISOString(),
        backoffUntilIso
      });
      return { status: 'backoff_skipped', keywords: cachedKeywords };
    }

    if (!res.ok) {
      return { status: 'error_skipped', keywords: cachedKeywords };
    }

    const xml = await res.text();
    const keywords = extractRssTitles(xml, 10);
    await upsertApiCacheEntry(db, {
      cacheKey,
      payloadJson: JSON.stringify({
        keywords,
        backoffCount: 0,
        fetchedAt: now.toISOString()
      }),
      expiresAtIso: new Date(now.getTime() + GOOGLE_TRENDS_CACHE_TTL_MS).toISOString(),
      backoffUntilIso: null
    });

    return { status: 'ok', keywords };
  } catch {
    return { status: 'error_skipped', keywords: cachedKeywords };
  }
}

export function toSerpSnippets(
  items: readonly NaverSearchResultItem[],
  source: 'blog' | 'news',
  limit = 5
): SerpSnippetItem[] {
  return items.slice(0, limit).map((item) => ({
    title: item.title.slice(0, 200),
    snippet: item.description.slice(0, 500),
    link: item.link.slice(0, 500),
    source
  }));
}
