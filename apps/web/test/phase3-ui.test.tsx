import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CategoryProfile,
  ManuscriptDetailResponse,
  NaverBlogManuscriptBundle,
  NgramEvaluationResult,
  TopicDiscoveryJSON
} from '@content-desk/shared';
import { ApiRequestError } from '../src/lib/api-client';
import { runNgramSimilarityCheck } from '../src/platform/ngram';
import { IsolatedPreview } from '../src/components/IsolatedPreview';
import { VerifyGate } from '../src/components/VerifyGate';
import { CategoriesPage } from '../src/pages/CategoriesPage';
import { DiscoveryPage } from '../src/pages/DiscoveryPage';
import { ManuscriptPage } from '../src/pages/ManuscriptPage';

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAMPLE_TREND_CATEGORY: CategoryProfile = {
  category_id: 'cat-tech',
  display_name: '테크/IT',
  naver_board_name: 'IT해설',
  discovery_mode: 'trend_first',
  datalab_anchor_keyword: '클라우드',
  seed_keywords: ['Cloudflare Workers'],
  primary_source_domains: ['developers.cloudflare.com'],
  default_media_policy: {
    allowed_content_types: ['explainer', 'experience_review'],
    min_real_photos: 0,
    require_field_memo: false
  },
  default_visibility: '전체공개',
  created_at: '2026-11-26T00:00:00.000Z',
  updated_at: '2026-11-26T00:00:00.000Z'
};

const SAMPLE_TOPIC: TopicDiscoveryJSON = {
  topic_id: 'topic-1',
  run_id: 'run-1',
  track: 'category_discovery',
  category_id: 'cat-tech',
  content_type: 'explainer',
  status: 'READY',
  keyword: 'Cloudflare Workers',
  capture_ids: [],
  sources: [
    {
      source_id: 'snap-1',
      url: 'https://developers.cloudflare.com/workers/',
      domain: 'developers.cloudflare.com',
      r2_key: 'users/u1/snapshots/topic-1/snap-1.txt',
      fetched_at: '2026-11-26T00:00:00.000Z',
      body_sha256: 'a'.repeat(64),
      ingest_channel: 'webkr_search',
      char_count: 500
    }
  ],
  ymyl_status: 'SAFE',
  sponsorship: { is_sponsored: false },
  datalab_demand_index: 88,
  blog_supply_count: 250,
  news_supply_count: 14,
  monthly_search_volume: null,
  competition_score: null,
  serp_snippets: [
    {
      title: 'Workers 요약',
      snippet: 'Cloudflare Workers는 엣지 서버리스 런타임입니다.',
      source: 'blog'
    }
  ],
  created_at: '2026-11-26T00:00:00.000Z'
};

const BASE_MANUSCRIPT: NaverBlogManuscriptBundle = {
  manuscript_id: 'ms-1',
  topic_id: 'topic-1',
  version: 1,
  content_hash: 'b'.repeat(64),
  title_candidates: ['Cloudflare Workers 정리', 'Workers 입문'],
  selected_title: 'Cloudflare Workers 정리',
  body_html:
    '<p>Cloudflare Workers는 엣지 서버리스 런타임입니다. [VERIFY]</p><p>[📷 이미지 1 삽입 위치: 아키텍처 메모]</p>',
  naver_board_name: 'IT해설',
  sponsorship: { is_sponsored: false },
  ftc_disclosure: null,
  ai_disclosure: null,
  images: [
    {
      seq: 1,
      r2_key: 'users/u1/captures/cap-1/1.webp',
      caption: '아키텍처 메모',
      is_ai_generated: false
    }
  ],
  tags: ['Cloudflare', 'Workers'],
  visibility: '전체공개',
  claims: [
    {
      claim_id: 'c-1',
      claim: '무료 플랜은 일일 100,000건 요청을 지원합니다.',
      source_id: 'snap-1',
      quote: '<script>alert("xss")</script>일일 100,000건 요청',
      verification_status: 'VERIFY_REQUIRED',
      resolution_url: null
    }
  ],
  ngram_max_similarity: null,
  approved_hash: null,
  approved_at: null
};

describe('Phase 3 Web: N-gram 30% + Worker/폴백, IsolatedPreview, VerifyGate', () => {
  it('computes char 3-gram similarity via fallback and Web Worker mock with 30% warning threshold', async () => {
    const text = '클라우드플레어 워커스 무료 플랜은 일일 십만 건의 요청을 처리할 수 있습니다.';
    const copiedRef = {
      id: 's1',
      kind: 'serp_snippet' as const,
      label: '상위 스니펫',
      text: '클라우드플레어 워커스 무료 플랜은 일일 십만 건의 요청을 처리'
    };

    // Fallback path (no Worker in jsdom)
    const fallbackRes = await runNgramSimilarityCheck(text, [copiedRef]);
    expect(fallbackRes.warning).toBe(true);
    expect(fallbackRes.maxSimilarity).toBeGreaterThanOrEqual(0.3);

    // Worker path via injected mock Worker
    const terminate = vi.fn();
    const mockWorkerObj: {
      onmessage: ((ev: MessageEvent) => void) | null;
      onerror: ((ev: ErrorEvent) => void) | null;
      terminate: typeof terminate;
      postMessage: (data: { requestId: string }) => void;
    } = {
      onmessage: null,
      onerror: null,
      terminate,
      postMessage(data: { requestId: string }) {
        const res: NgramEvaluationResult = {
          ngramSize: 3,
          threshold: 0.3,
          maxSimilarity: 0.42,
          warning: true,
          matches: [
            {
              id: 's1',
              kind: 'serp_snippet',
              label: '상위 스니펫',
              similarity: 0.42,
              warning: true
            }
          ]
        };
        mockWorkerObj.onmessage?.({ data: { requestId: data.requestId, result: res } } as MessageEvent);
      }
    };
    const mockWorker = mockWorkerObj as unknown as Worker;

    const workerRes = await runNgramSimilarityCheck(text, [copiedRef], {
      createWorker: () => mockWorker
    });
    expect(workerRes.maxSimilarity).toBe(0.42);
    expect(workerRes.warning).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('renders IsolatedPreview inside iframe sandbox="" and strips XSS scripts & unlisted links', () => {
    render(
      <IsolatedPreview
        title="테스트 제목"
        bodyHtml={
          '<p onclick="alert(1)">본문</p><script>window.hacked=1</script>' +
          '<a href="https://developers.cloudflare.com/workers/">허용 링크</a>' +
          '<a href="https://evil.example/x">차단 링크</a>'
        }
        allowedSourceUrls={['https://developers.cloudflare.com/workers/']}
      />
    );

    const iframe = screen.getByTitle('원고 격리 미리보기') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('');
    const srcDoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcDoc).not.toContain('<script>');
    expect(srcDoc).not.toContain('onclick=');
    expect(srcDoc).not.toContain('evil.example');
    expect(srcDoc).toContain('https://developers.cloudflare.com/workers/');
    expect(srcDoc).toContain('차단 링크');
  });

  it('blocks approval in VerifyGate while [VERIFY] is unresolved, displays quotes as plain text, and enables approval when resolved', () => {
    const onResolve = vi.fn();
    const onApprove = vi.fn();

    const { rerender } = render(
      <VerifyGate
        manuscript={BASE_MANUSCRIPT}
        unresolvedVerifyCount={1}
        sources={[
          {
            ...SAMPLE_TOPIC.sources[0]!,
            excerpt: '공식 문서 발췌 텍스트'
          }
        ]}
        ngramResult={{
          ngramSize: 3,
          threshold: 0.3,
          maxSimilarity: 0.35,
          warning: true,
          matches: [
            {
              id: 'serp-1',
              kind: 'serp_snippet',
              label: 'SERP #1',
              similarity: 0.35,
              warning: true
            }
          ]
        }}
        isNgramLoading={false}
        isResolving={false}
        isApproving={false}
        onResolveClaim={onResolve}
        onApprove={onApprove}
      />
    );

    // 30% N-gram warning visible
    expect(screen.getByRole('alert')).toHaveTextContent('30% 이상(35.0%)');

    // Quote rendered as plain text (script tag visible as literal text, never executed)
    expect(screen.getByText(/<script>alert\("xss"\)<\/script>/)).toBeInTheDocument();

    // Approve button MUST be disabled while [VERIFY] unresolved
    const approveBtn = screen.getByRole('button', { name: '검증 완료 · 원고 승인' });
    expect(approveBtn).toBeDisabled();

    // Resolve action works
    fireEvent.change(screen.getByLabelText('주장 c-1 확인 출처 URL'), {
      target: { value: 'https://developers.cloudflare.com/workers/platform/pricing/' }
    });
    fireEvent.click(screen.getByRole('button', { name: '출처 확인 해소' }));
    expect(onResolve).toHaveBeenCalledWith({
      claim_id: 'c-1',
      action: 'confirm_with_url',
      resolution_url: 'https://developers.cloudflare.com/workers/platform/pricing/'
    });

    // Re-render with resolved claims and [VERIFY] stripped -> approve button enabled
    const cleanManuscript: NaverBlogManuscriptBundle = {
      ...BASE_MANUSCRIPT,
      body_html: '<p>Cloudflare Workers는 엣지 서버리스 런타임입니다.</p>',
      claims: [
        {
          ...BASE_MANUSCRIPT.claims[0]!,
          verification_status: 'RESOLVED_BY_OWNER',
          resolution_url: 'https://developers.cloudflare.com/workers/platform/pricing/'
        }
      ]
    };

    rerender(
      <VerifyGate
        manuscript={cleanManuscript}
        unresolvedVerifyCount={0}
        sources={[]}
        ngramResult={null}
        isNgramLoading={false}
        isResolving={false}
        isApproving={false}
        onResolveClaim={onResolve}
        onApprove={onApprove}
      />
    );

    const enabledBtn = screen.getByRole('button', { name: '검증 완료 · 원고 승인' });
    expect(enabledBtn).not.toBeDisabled();
    fireEvent.click(enabledBtn);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 3 Pages: CategoriesPage 409 확인 · DiscoveryPage · ManuscriptPage', () => {
  it('handles 409 YMYL_BORDERLINE_CONFIRM_REQUIRED in CategoriesPage and retries with confirm_borderline=true', async () => {
    const addCategory = vi.fn(async (input) => {
      if (!input.confirm_borderline) {
        throw new ApiRequestError(
          409,
          'YMYL_BORDERLINE_CONFIRM_REQUIRED',
          '경계 사례입니다. 비YMYL 여부를 확인해 주세요.'
        );
      }
      return {
        category: {
          ...input,
          category_id: 'cat-borderline-1',
          created_at: '2026-11-26T00:00:00.000Z',
          updated_at: '2026-11-26T00:00:00.000Z'
        }
      };
    });

    renderWithQuery(
      <CategoriesPage
        listCategories={async () => ({ categories: [] })}
        addCategory={addCategory}
        editCategory={vi.fn()}
        removeCategory={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText('카테고리 표시명'), {
      target: { value: '건강한 개발 습관' }
    });
    fireEvent.change(screen.getByLabelText('네이버 블로그 게시판명'), {
      target: { value: '개발일기' }
    });
    fireEvent.change(screen.getByLabelText(/데이터랩 기준 키워드/), {
      target: { value: '개발자' }
    });
    fireEvent.click(screen.getByRole('button', { name: '카테고리 추가' }));

    expect(await screen.findByText('YMYL 경계 사례 확인 필요 (409)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '경계 사례 확인 후 저장' }));

    await waitFor(() => {
      expect(addCategory).toHaveBeenCalledTimes(2);
      expect(addCategory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          display_name: '건강한 개발 습관',
          confirm_borderline: true
        })
      );
    });
  });

  it('executes DiscoveryPage 1~3 step pipeline and handles Step 4 unlisted domain 409 confirmation', async () => {
    let topicsState: TopicDiscoveryJSON[] = [];
    const runStep1 = vi.fn(async () => {
      const discovered: TopicDiscoveryJSON = {
        ...SAMPLE_TOPIC,
        status: 'DISCOVERED',
        sources: []
      };
      topicsState = [discovered];
      return {
        run_id: 'run-1',
        category_id: 'cat-tech',
        google_trends_status: 'backoff_skipped' as const,
        topics: [discovered],
        blocked_keywords: []
      };
    });
    const runStep2 = vi.fn(async () => ({
      run_id: 'run-1',
      cache_hits: 0,
      api_calls: 1,
      topics: topicsState
    }));
    const runStep3 = vi.fn(async () => ({
      run_id: 'run-1',
      searchad_used: false,
      topics: topicsState
    }));
    const saveSnapshot = vi.fn(async (_id, input) => {
      if (!input.confirm_unlisted_domain) {
        throw new ApiRequestError(
          409,
          'SOURCE_DOMAIN_CONFIRM_REQUIRED',
          '허용 목록 외 도메인입니다. 확인 후 저장해 주세요.'
        );
      }
      const updated = { ...SAMPLE_TOPIC, status: 'READY' as const };
      topicsState = [updated];
      return {
        snapshot: {
          ...SAMPLE_TOPIC.sources[0]!,
          char_count: 500,
          excerpt: '스냅샷 발췌'
        },
        topic: updated
      };
    });

    renderWithQuery(
      <DiscoveryPage
        listCategories={async () => ({ categories: [SAMPLE_TREND_CATEGORY] })}
        listCaptures={async () => ({ captures: [] })}
        listTopics={async () => ({ topics: [...topicsState] })}
        runStep1={runStep1}
        runStep2={runStep2}
        runStep3={runStep3}
        saveSourceSnapshot={saveSnapshot}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '1~3단계 글감 발굴 실행' })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: '1~3단계 글감 발굴 실행' }));

    await waitFor(() => {
      expect(runStep1).toHaveBeenCalledTimes(1);
      expect(runStep2).toHaveBeenCalledTimes(1);
      expect(runStep3).toHaveBeenCalledTimes(1);
    });

    // Step 4 unlisted domain manual input -> 409 warning -> confirm retry
    const urlInput = await screen.findByLabelText('1차 출처 직접 URL');
    fireEvent.change(urlInput, { target: { value: 'https://custom-vendor.example/docs' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 URL 스냅샷 저장' }));

    expect(await screen.findByText('목록 외 도메인 경고 (409)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '목록 외 도메인 확인 후 스냅샷 저장' }));

    await waitFor(() => {
      expect(saveSnapshot).toHaveBeenCalledTimes(2);
      expect(saveSnapshot).toHaveBeenLastCalledWith(
        'topic-1',
        expect.objectContaining({
          url: 'https://custom-vendor.example/docs',
          confirm_unlisted_domain: true
        })
      );
    });
  });

  it('runs ManuscriptPage LLM consent -> 2-request generate + verify-sanitize flow and shows photo markers & metadata only', async () => {
    const detailState: ManuscriptDetailResponse = {
      manuscript: BASE_MANUSCRIPT,
      unresolved_verify_count: 1,
      content_type: 'explainer',
      category_id: 'cat-tech',
      run_id: 'run-ms-1',
      topic: SAMPLE_TOPIC,
      comparison_context: {
        past_manuscripts: [],
        serp_snippets: [
          {
            id: 'serp-1',
            label: '[블로그] Workers 요약',
            text: 'Cloudflare Workers는 엣지 서버리스 런타임입니다.'
          }
        ],
        sources: [{ ...SAMPLE_TOPIC.sources[0]!, excerpt: '공식 문서 발췌' }],
        capture_photos: [
          {
            seq: 1,
            r2_key: 'users/u1/captures/cap-1/1.webp',
            mime_type: 'image/webp',
            byte_size: 120_000,
            taken_at: '2026-11-26T10:00:00+09:00',
            width: 1600,
            height: 1200,
            caption: '아키텍처 메모'
          }
        ],
        capture_memo: '현장 메모 내용'
      }
    };

    let created = false;
    const requestGenerate = vi.fn(async () => {
      created = true;
      return {
        manuscript: BASE_MANUSCRIPT,
        unresolved_verify_count: 1,
        content_type: 'explainer' as const,
        category_id: 'cat-tech',
        run_id: 'run-ms-1'
      };
    });
    const requestVerifySanitize = vi.fn(async () => ({
      manuscript: BASE_MANUSCRIPT,
      unresolved_verify_count: 1,
      verified_claim_count: 0,
      flagged_claim_count: 1,
      sanitized: true as const
    }));

    renderWithQuery(
      <ManuscriptPage
        listTopics={async () => ({ topics: [SAMPLE_TOPIC] })}
        listCaptures={async () => ({ captures: [] })}
        listManuscripts={async () => ({
          manuscripts: created
            ? [
                {
                  manuscript_id: 'ms-1',
                  topic_id: 'topic-1',
                  category_id: 'cat-tech',
                  content_type: 'explainer',
                  run_id: 'run-ms-1',
                  version: 1,
                  selected_title: BASE_MANUSCRIPT.selected_title,
                  content_hash: BASE_MANUSCRIPT.content_hash,
                  approved_hash: null,
                  approved_at: null,
                  unresolved_verify_count: 1,
                  created_at: '2026-11-26T00:00:00.000Z',
                  updated_at: '2026-11-26T00:00:00.000Z'
                }
              ]
            : []
        })}
        loadManuscriptDetail={async () => detailState}
        loadDownloadUrls={async () => ({
          expires_in_seconds: 600,
          items: [
            {
              seq: 1,
              r2_key: 'users/u1/captures/cap-1/1.webp',
              caption: '아키텍처 메모',
              is_ai_generated: false,
              download_url: 'https://r2.example/users/u1/captures/cap-1/1.webp?sig=1',
              expires_at: '2026-11-26T00:10:00.000Z'
            }
          ]
        })}
        requestGenerate={requestGenerate}
        requestVerifySanitize={requestVerifySanitize}
      />
    );

    const genBtn = await screen.findByRole('button', { name: '원고 생성 → 대조·정제 실행' });
    // Consent checkbox unchecked -> button disabled
    expect(genBtn).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /무료 티어 LLM/ }));
    expect(genBtn).not.toBeDisabled();
    fireEvent.click(genBtn);

    await waitFor(() => {
      expect(requestGenerate).toHaveBeenCalledTimes(1);
      expect(requestVerifySanitize).toHaveBeenCalledWith('ms-1');
    });

    // Photo thumbnail, markers & metadata shown (Phase 4 R2 download-urls connected)
    expect(await screen.findByText('R2 썸네일 1장 연결됨')).toBeInTheDocument();
    expect(screen.getByAltText('아키텍처 메모')).toHaveAttribute(
      'src',
      'https://r2.example/users/u1/captures/cap-1/1.webp?sig=1'
    );
    expect(screen.getByText('[📷 이미지 1 삽입 위치: 아키텍처 메모]')).toBeInTheDocument();
    expect(screen.getByText('01_아키텍처_메모.jpg')).toBeInTheDocument();
    expect(screen.getByText(/1600×1200/)).toBeInTheDocument();
  });
});
