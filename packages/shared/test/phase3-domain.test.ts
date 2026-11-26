import { describe, expect, it } from 'vitest';
import {
  buildEffectivePrimarySourceDomains,
  checkPrimarySourceUrlDomain,
  computeCharNgramSimilarity,
  DEFAULT_PRIMARY_SOURCE_DOMAINS,
  evaluateNgramSimilarity,
  GEMINI_TEXT_MODEL,
  getNextResetIso,
  getProviderDailyCap,
  getProviderResetTimezone,
  getProviderWindowDate,
  NGRAM_WARNING_THRESHOLD,
  normalizeTextForNgram,
  QUOTA_PROVIDER_CONFIGS,
  readyTopicDiscoverySchema,
  topicDiscoverySchema
} from '../src/index.js';

describe('Phase 3 shared domain: quota, source domains, ngram, topic states', () => {
  it('enforces owner-confirmed quota caps, Gemini model, and timezone mapping', () => {
    expect(GEMINI_TEXT_MODEL).toBe('gemini-2.5-flash');
    expect(getProviderDailyCap('naver_search')).toBe(25_000);
    expect(getProviderDailyCap('naver_datalab')).toBe(1_000);
    expect(getProviderDailyCap('naver_searchad')).toBe(1_000);
    expect(getProviderDailyCap('gemini_text')).toBe(250);
    expect(getProviderDailyCap('gemini_image')).toBe(0);
    expect(getProviderDailyCap('d1_reads')).toBe(4_000_000);
    expect(getProviderDailyCap('d1_writes')).toBe(80_000);

    expect(getProviderResetTimezone('gemini_text')).toBe('America/Los_Angeles');
    expect(getProviderResetTimezone('gemini_image')).toBe('America/Los_Angeles');
    expect(getProviderResetTimezone('naver_search')).toBe('UTC');
    expect(getProviderResetTimezone('d1_reads')).toBe('UTC');
    expect(QUOTA_PROVIDER_CONFIGS.d1_writes.resetTz).toBe('UTC');

    // 2026-11-26T03:00:00Z -> UTC is 2026-11-26, Pacific (PST -08:00) is 2026-11-25
    const splitTime = new Date('2026-11-26T03:00:00.000Z');
    expect(getProviderWindowDate('naver_search', splitTime)).toBe('2026-11-26');
    expect(getProviderWindowDate('gemini_text', splitTime)).toBe('2026-11-25');
    expect(getNextResetIso('UTC', splitTime)).toBe('2026-11-27T00:00:00.000Z');
    expect(getNextResetIso('America/Los_Angeles', splitTime)).toBe('2026-11-26T08:00:00.000Z');
  });

  it('validates primary source domains with strict suffix matching and blocks spoofing', () => {
    expect(DEFAULT_PRIMARY_SOURCE_DOMAINS).toContain('go.kr');
    expect(DEFAULT_PRIMARY_SOURCE_DOMAINS).toContain('law.go.kr');
    expect(DEFAULT_PRIMARY_SOURCE_DOMAINS).toContain('ac.kr');
    expect(DEFAULT_PRIMARY_SOURCE_DOMAINS).toContain('or.kr');
    expect(DEFAULT_PRIMARY_SOURCE_DOMAINS).toContain('re.kr');

    expect(checkPrimarySourceUrlDomain('https://www.msit.go.kr/press/1').allowed).toBe(true);
    expect(checkPrimarySourceUrlDomain('https://law.go.kr/lsInfoP.do').allowed).toBe(true);
    expect(checkPrimarySourceUrlDomain('https://developers.cloudflare.com/d1', ['developers.cloudflare.com']).allowed).toBe(true);

    // Spoofed domains must be rejected
    expect(checkPrimarySourceUrlDomain('https://evilgo.kr/article').allowed).toBe(false);
    expect(checkPrimarySourceUrlDomain('https://go.kr.evil.com/article').allowed).toBe(false);
    expect(checkPrimarySourceUrlDomain('https://blog.naver.com/post/1').allowed).toBe(false);
    expect(checkPrimarySourceUrlDomain('javascript:alert(1)').allowed).toBe(false);

    expect(buildEffectivePrimarySourceDomains(['React.Dev'])).toContain('react.dev');
  });

  it('computes char 3-gram similarity and flags warnings at >= 30%', () => {
    expect(NGRAM_WARNING_THRESHOLD).toBe(0.3);
    expect(normalizeTextForNgram('<p>클라우드  D1\t테스트!</p>')).toBe('클라우드d1테스트!');

    const baseText =
      '클라우드플레어 워커스와 D1 데이터베이스를 활용하면 서버리스 환경에서 무료로 블로그 자동화 백엔드를 운영할 수 있습니다.';
    const copiedSnippet =
      '클라우드플레어 워커스와 D1 데이터베이스를 활용하면 서버리스 환경에서 무료로 운영할 수 있습니다.';
    const unrelatedText =
      '제주도 성산일출봉 근처 카페에서 감귤 라떼와 크루아상을 먹으며 바다 풍경을 감상했습니다.';

    const highSim = computeCharNgramSimilarity(baseText, copiedSnippet);
    const lowSim = computeCharNgramSimilarity(baseText, unrelatedText);

    expect(highSim).toBeGreaterThanOrEqual(0.3);
    expect(lowSim).toBeLessThan(0.3);

    const evaluated = evaluateNgramSimilarity(baseText, [
      { id: 'serp-1', kind: 'serp_snippet', label: 'SERP #1', text: copiedSnippet },
      { id: 'ms-1', kind: 'past_manuscript', label: '과거 원고', text: unrelatedText }
    ]);

    expect(evaluated.warning).toBe(true);
    expect(evaluated.maxSimilarity).toBe(highSim);
    expect(evaluated.matches[0]?.id).toBe('serp-1');
    expect(evaluated.matches[0]?.warning).toBe(true);
    expect(evaluated.matches[1]?.warning).toBe(false);
  });

  it('separates step 1-3 discovered explainer state from step 4 READY state', () => {
    const baseTopic = {
      topic_id: 'topic-1',
      run_id: 'run-1',
      track: 'category_discovery' as const,
      category_id: 'cat-tech',
      content_type: 'explainer' as const,
      keyword: 'Cloudflare Workers',
      capture_ids: [],
      sources: [],
      ymyl_status: 'SAFE' as const,
      sponsorship: { is_sponsored: false },
      datalab_demand_index: 72,
      blog_supply_count: 150,
      news_supply_count: 12,
      monthly_search_volume: null,
      competition_score: null,
      created_at: '2026-11-26T00:00:00.000Z'
    };

    // Steps 1~3 status allows empty sources for explainer
    expect(topicDiscoverySchema.safeParse({ ...baseTopic, status: 'DISCOVERED' }).success).toBe(true);
    expect(topicDiscoverySchema.safeParse({ ...baseTopic, status: 'SUPPLY_SCORED' }).success).toBe(true);

    // READY status (or omitted default) rejects empty sources for explainer
    expect(topicDiscoverySchema.safeParse({ ...baseTopic, status: 'READY' }).success).toBe(false);
    expect(readyTopicDiscoverySchema.safeParse({ ...baseTopic, status: 'DISCOVERED' }).success).toBe(false);
  });
});
