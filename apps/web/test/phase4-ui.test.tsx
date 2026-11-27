import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardSummaryResponse,
  ExportResponse,
  ManuscriptDetailResponse,
  MeResponse,
  NaverBlogManuscriptBundle,
  PublishedPostItem,
  SettingsResponse
} from '@content-desk/shared';
import { normalizeApiBaseUrl, validateProductionApiBaseUrl } from '../src/lib/csp';
import {
  buildNaverCopyPayload,
  copyRichManuscriptToClipboard
} from '../src/platform/clipboard';
import {
  copySingleImageAsPngToClipboard,
  DOWNLOAD_REVOKE_DELAY_MS,
  exportPreparedImages,
  prepareShareImagesFromDownloadUrls,
  type PreparedShareImage
} from '../src/platform/share';
import { CopyPanelPage } from '../src/pages/CopyPanelPage';
import { DashboardPage } from '../src/pages/DashboardPage';
import { ManuscriptPage } from '../src/pages/ManuscriptPage';
import { PublishTrackerPage } from '../src/pages/PublishTrackerPage';
import { SettingsPage } from '../src/pages/SettingsPage';

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const HASH_V1 = 'a'.repeat(64);
const HASH_V2 = 'b'.repeat(64);

const BASE_ME: MeResponse = {
  uid: 'owner-uid-1',
  email: 'owner@example.com',
  role: 'admin',
  auth_time: 1732000000,
  session_expires_at: '2026-12-10T00:00:00.000Z',
  reauth_valid_until: '2026-11-26T01:15:00.000Z',
  d1_connected: true
};

const APPROVED_BUNDLE: NaverBlogManuscriptBundle = {
  manuscript_id: 'ms-approved-1',
  topic_id: 'topic-1',
  version: 2,
  content_hash: HASH_V1,
  title_candidates: ['성수동 카페 방문 후기'],
  selected_title: '성수동 카페 방문 후기',
  body_html:
    '<h2>방문 요약</h2><p>드립 커피가 깔끔했습니다.</p><p>[📷 이미지 1 삽입 위치: 아메리카노 잔]</p>',
  naver_board_name: '카페 후기',
  sponsorship: {
    is_sponsored: true,
    provider_name: '성수커피',
    compensation_type: '음료 무상 제공'
  },
  ftc_disclosure: '본 포스팅은 성수커피로부터 음료 무상 제공를 제공받아 작성하였습니다.',
  ai_disclosure: '본문 내 일부 개념 도식 이미지는 이해를 돕기 위해 AI로 생성되었습니다.',
  images: [
    {
      seq: 1,
      r2_key: 'users/owner-uid-1/captures/cap-1/1.webp',
      caption: '아메리카노 잔',
      is_ai_generated: false
    }
  ],
  tags: ['성수카페', '드립커피'],
  visibility: '전체공개',
  claims: [],
  ngram_max_similarity: 0.12,
  sanitized_at: '2026-11-26T00:00:00.000Z',
  approved_hash: HASH_V1,
  approved_at: '2026-11-26T00:05:00.000Z'
};

function makeDetail(
  overrides?: Partial<NaverBlogManuscriptBundle>,
  unresolvedVerifyCount = 0
): ManuscriptDetailResponse {
  const manuscript: NaverBlogManuscriptBundle = {
    ...APPROVED_BUNDLE,
    ...overrides
  };
  return {
    manuscript,
    unresolved_verify_count: unresolvedVerifyCount,
    content_type: 'experience_review',
    category_id: 'cat-cafe',
    run_id: 'run-1',
    topic: {
      topic_id: 'topic-1',
      run_id: 'run-1',
      track: 'category_discovery',
      category_id: 'cat-cafe',
      content_type: 'experience_review',
      status: 'READY',
      keyword: '성수동 카페',
      capture_ids: ['cap-1'],
      sources: [],
      ymyl_status: 'SAFE',
      sponsorship: manuscript.sponsorship,
      datalab_demand_index: 70,
      blog_supply_count: 100,
      news_supply_count: 2,
      monthly_search_volume: null,
      competition_score: null,
      created_at: '2026-11-26T00:00:00.000Z'
    },
    comparison_context: {
      past_manuscripts: [],
      serp_snippets: [],
      sources: [],
      capture_photos: [
        {
          seq: 1,
          r2_key: 'users/owner-uid-1/captures/cap-1/1.webp',
          mime_type: 'image/webp',
          byte_size: 95_000,
          taken_at: '2026-11-26T09:00:00+09:00',
          width: 1200,
          height: 900,
          caption: '아메리카노 잔'
        }
      ],
      capture_memo: '성수동 현장 메모'
    }
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Phase 4 Platform: clipboard.ts, share.ts, and VITE_API_BASE_URL production build guard', () => {
  it('enforces verified copy gate, writes ClipboardItem synchronously with disclosures & image markers, and falls back to plain text', async () => {
    // Gate rejects unapproved manuscript
    expect(() =>
      copyRichManuscriptToClipboard(
        {
          bodyHtml: APPROVED_BUNDLE.body_html,
          allowedSourceUrls: []
        },
        {
          manuscript: { content_hash: HASH_V2, approved_hash: HASH_V1 },
          unresolvedVerifyCount: 0
        }
      )
    ).toThrow(/검증 완료/);

    // Payload includes FTC disclosure (top), sanitized HTML, image markers, AI disclosure (bottom)
    const payload = buildNaverCopyPayload({
      bodyHtml: '<p onclick="evil()">본문</p><script>alert(1)</script>',
      allowedSourceUrls: [],
      ftcDisclosure: APPROVED_BUNDLE.ftc_disclosure,
      aiDisclosure: APPROVED_BUNDLE.ai_disclosure,
      images: APPROVED_BUNDLE.images
    });
    expect(payload.html).not.toContain('<script>');
    expect(payload.html).not.toContain('onclick');
    expect(payload.html).toContain(APPROVED_BUNDLE.ftc_disclosure!);
    expect(payload.html).toContain(APPROVED_BUNDLE.ai_disclosure!);
    expect(payload.html).toContain('[📷 이미지 1 삽입 위치: 아메리카노 잔]');
    expect(payload.plainText).toContain(APPROVED_BUNDLE.ftc_disclosure!);
    expect(payload.plainText).toContain('[📷 이미지 1 삽입 위치: 아메리카노 잔]');
    expect(payload.plainText).toContain(APPROVED_BUNDLE.ai_disclosure!);

    // Synchronous ClipboardItem write
    let wroteSync = false;
    const writeMock = vi.fn(() => {
      wroteSync = true;
      return Promise.resolve();
    });
    class MockClipboardItem {
      readonly data: Record<string, Blob | PromiseLike<Blob>>;
      constructor(data: Record<string, Blob | PromiseLike<Blob>>) {
        this.data = data;
      }
    }
    vi.stubGlobal('ClipboardItem', MockClipboardItem);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: writeMock, writeText: vi.fn(() => Promise.resolve()) },
      configurable: true
    });

    const p = copyRichManuscriptToClipboard(
      {
        bodyHtml: APPROVED_BUNDLE.body_html,
        allowedSourceUrls: [],
        ftcDisclosure: APPROVED_BUNDLE.ftc_disclosure,
        aiDisclosure: APPROVED_BUNDLE.ai_disclosure,
        images: APPROVED_BUNDLE.images
      },
      { manuscript: APPROVED_BUNDLE, unresolvedVerifyCount: 0 }
    );
    expect(wroteSync).toBe(true);
    const res = await p;
    expect(res.mode).toBe('rich');
    expect(writeMock).toHaveBeenCalledTimes(1);

    // Fallback to writeText when ClipboardItem is unavailable
    vi.stubGlobal('ClipboardItem', undefined);
    const writeTextMock = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true
    });
    const fallbackRes = await copyRichManuscriptToClipboard(
      {
        bodyHtml: APPROVED_BUNDLE.body_html,
        allowedSourceUrls: [],
        ftcDisclosure: APPROVED_BUNDLE.ftc_disclosure,
        aiDisclosure: APPROVED_BUNDLE.ai_disclosure,
        images: APPROVED_BUNDLE.images
      },
      { manuscript: APPROVED_BUNDLE, unresolvedVerifyCount: 0 }
    );
    expect(fallbackRes.mode).toBe('plain');
    expect(writeTextMock).toHaveBeenCalledTimes(1);
  });

  it('prepares sequential JPEG files from download-urls, uses Web Share when supported, falls back to sequential JPEG download, and supports PC PNG copy', async () => {
    const fakeWebpBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const fakeJpegBlob = new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' });
    const fakePngBlob = new Blob([new Uint8Array([7, 8, 9])], { type: 'image/png' });

    const prepared = await prepareShareImagesFromDownloadUrls(
      [
        {
          seq: 1,
          r2_key: 'users/u1/captures/c1/1.webp',
          caption: '아메리카노 잔',
          is_ai_generated: false,
          download_url: 'https://r2.example/1.webp',
          expires_at: '2026-11-26T00:10:00.000Z'
        },
        {
          seq: 2,
          r2_key: 'users/u1/captures/c1/2.webp',
          caption: '매장 전경',
          is_ai_generated: false,
          download_url: 'https://r2.example/2.webp',
          expires_at: '2026-11-26T00:10:00.000Z'
        }
      ],
      {
        fetchImpl: vi.fn(async () => new Response(fakeWebpBlob, { status: 200 })) as typeof fetch,
        convertBlob: vi.fn(async (_b, mime) => (mime === 'image/png' ? fakePngBlob : fakeJpegBlob))
      }
    );

    expect(prepared).toHaveLength(2);
    expect(prepared[0]!.filename).toBe('01_아메리카노_잔.jpg');
    expect(prepared[1]!.filename).toBe('02_매장_전경.jpg');
    expect(prepared[0]!.jpegFile?.type).toBe('image/jpeg');

    const gate = { manuscript: APPROVED_BUNDLE, unresolvedVerifyCount: 0 };

    // 1) Web Share supported -> invokes navigator.share synchronously
    let sharedSync = false;
    const shareMock = vi.fn(() => {
      sharedSync = true;
      return Promise.resolve();
    });
    Object.defineProperty(navigator, 'canShare', { value: vi.fn(() => true), configurable: true });
    Object.defineProperty(navigator, 'share', { value: shareMock, configurable: true });

    const sharePromise = exportPreparedImages(prepared, gate, { title: '성수동 카페' });
    expect(sharedSync).toBe(true);
    const shareResult = await sharePromise;
    expect(shareResult).toEqual({ mode: 'web_share', count: 2 });

    // 2) Web Share unsupported -> sequential individual JPEG download fallback (no ZIP)
    Object.defineProperty(navigator, 'canShare', { value: vi.fn(() => false), configurable: true });
    const downloadedNames: string[] = [];
    const fallbackResult = await exportPreparedImages(prepared, gate, {
      downloadFile: (file) => downloadedNames.push(file.name),
      sequentialDelayMs: 0
    });
    expect(fallbackResult).toEqual({ mode: 'sequential_download', count: 2 });
    expect(downloadedNames).toEqual(['01_아메리카노_잔.jpg', '02_매장_전경.jpg']);
    expect(DOWNLOAD_REVOKE_DELAY_MS).toBeGreaterThanOrEqual(5_000);

    // 3) PC PNG clipboard copy
    class MockClipboardItem {
      constructor(public readonly data: Record<string, Blob | PromiseLike<Blob>>) {}
    }
    const writeMock = vi.fn(() => Promise.resolve());
    vi.stubGlobal('ClipboardItem', MockClipboardItem);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: writeMock },
      configurable: true
    });
    await copySingleImageAsPngToClipboard(prepared[0]!, gate, {
      convertBlob: vi.fn(async () => fakePngBlob)
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it('enforces VITE_API_BASE_URL production build guard on CF_PAGES=1 or REQUIRE_API_BASE_URL=true while allowing local build with warning', () => {
    // Strict mode throws on empty or non-https
    expect(() =>
      validateProductionApiBaseUrl('', { cfPages: '1' })
    ).toThrow(/VITE_API_BASE_URL/);
    expect(() =>
      validateProductionApiBaseUrl('http://127.0.0.1:8787', { cfPages: '1' })
    ).toThrow(/https:\/\//);
    expect(() =>
      validateProductionApiBaseUrl('not-a-url', { requireApiBaseUrl: 'true' })
    ).toThrow(/유효한 URL/);

    // Strict mode passes on valid https:// URL
    const validProd = validateProductionApiBaseUrl('https://content-desk-worker.example.workers.dev', {
      cfPages: '1'
    });
    expect(validProd.valid).toBe(true);
    expect(validProd.strict).toBe(true);
    expect(validProd.warning).toBeNull();

    // Local build (non-strict) passes with warning when empty
    const localEmpty = validateProductionApiBaseUrl('', {});
    expect(localEmpty.strict).toBe(false);
    expect(localEmpty.warning).toContain('로컬 프록시');

    // normalizeApiBaseUrl trims whitespace and strips trailing slashes consistently
    expect(normalizeApiBaseUrl('  https://api.example.workers.dev///  ')).toBe(
      'https://api.example.workers.dev'
    );
    expect(normalizeApiBaseUrl('   ')).toBe('');
    expect(normalizeApiBaseUrl(undefined)).toBe('');
  });

  it('does not duplicate FTC disclosure or image markers when sponsor name or caption contains &, ", or single quotes', () => {
    const ftc = '본 포스팅은 A&B "프리미엄" 로스터스로부터 \'원두\'를 제공받아 작성하였습니다.';
    const caption = 'A&B "시그니처" \'라떼\'';
    const bodyWithEscaped =
      '<p><strong>본 포스팅은 A&amp;B &quot;프리미엄&quot; 로스터스로부터 &#39;원두&#39;를 제공받아 작성하였습니다.</strong></p>' +
      '<p>본문 내용입니다.</p>' +
      '<p>[📷 이미지 1 삽입 위치: A&amp;B &quot;시그니처&quot; &#39;라떼&#39;]</p>';

    const payload = buildNaverCopyPayload({
      bodyHtml: bodyWithEscaped,
      allowedSourceUrls: [],
      ftcDisclosure: ftc,
      images: [{ seq: 1, caption }]
    });

    const ftcOccurrences = payload.plainText.split('A&B "프리미엄"').length - 1;
    const markerOccurrences = payload.plainText.split('[📷 이미지 1 삽입 위치:').length - 1;
    expect(ftcOccurrences).toBe(1);
    expect(markerOccurrences).toBe(1);
  });
});

describe('Phase 4 Pages: CopyPanelPage, ManuscriptPage thumbnails, PublishTrackerPage, DashboardPage warnings, SettingsPage', () => {
  it('locks CopyPanelPage when unapproved/modified and enables copy/export + blogId write link when approved', async () => {
    const onNavigateToManuscript = vi.fn();

    // 1) Locked state (modified after approval: approved_hash !== content_hash)
    const lockedDetail = makeDetail({ approved_hash: HASH_V2, content_hash: HASH_V1 }, 0);
    const { unmount } = renderWithQuery(
      <CopyPanelPage
        listManuscripts={async () => ({
          manuscripts: [
            {
              manuscript_id: lockedDetail.manuscript.manuscript_id,
              topic_id: 'topic-1',
              category_id: 'cat-cafe',
              content_type: 'experience_review',
              run_id: 'run-1',
              version: 2,
              selected_title: lockedDetail.manuscript.selected_title,
              content_hash: HASH_V1,
              approved_hash: HASH_V2,
              approved_at: null,
              unresolved_verify_count: 0,
              created_at: '2026-11-26T00:00:00.000Z',
              updated_at: '2026-11-26T00:00:00.000Z'
            }
          ]
        })}
        loadManuscriptDetail={async () => lockedDetail}
        loadSettings={async () => ({
          naver_blog_id: null,
          last_full_export_at: null,
          backup_reminder_due: false,
          days_since_export: null
        })}
        onNavigateToManuscript={onNavigateToManuscript}
      />
    );

    expect(await screen.findByTestId('copy-gate-locked')).toHaveTextContent('승인이 해제되었습니다');
    expect(screen.getByRole('button', { name: '제목 복사' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '서식 유지 본문 복사' })).toBeDisabled();
    expect(screen.getByRole('link', { name: '네이버 블로그 글쓰기 열기' })).toHaveAttribute(
      'href',
      'https://blog.naver.com/GoBlogWrite.naver'
    );
    fireEvent.click(screen.getByRole('button', { name: '검증 화면으로 이동' }));
    expect(onNavigateToManuscript).toHaveBeenCalledWith('ms-approved-1');
    unmount();

    // 2) Approved state with naver_blog_id set + preloaded JPEG
    const approvedDetail = makeDetail();
    const preparedMock: PreparedShareImage[] = [
      {
        seq: 1,
        caption: '아메리카노 잔',
        r2Key: 'users/owner-uid-1/captures/cap-1/1.webp',
        filename: '01_아메리카노_잔.jpg',
        downloadUrl: 'https://r2.example/1.webp',
        jpegFile: new File([new Uint8Array([1])], '01_아메리카노_잔.jpg', { type: 'image/jpeg' }),
        status: 'ready'
      }
    ];
    const exportMock = vi.fn(async () => ({ mode: 'sequential_download' as const, count: 1 }));

    renderWithQuery(
      <CopyPanelPage
        listManuscripts={async () => ({
          manuscripts: [
            {
              manuscript_id: approvedDetail.manuscript.manuscript_id,
              topic_id: 'topic-1',
              category_id: 'cat-cafe',
              content_type: 'experience_review',
              run_id: 'run-1',
              version: 2,
              selected_title: approvedDetail.manuscript.selected_title,
              content_hash: HASH_V1,
              approved_hash: HASH_V1,
              approved_at: '2026-11-26T00:05:00.000Z',
              unresolved_verify_count: 0,
              created_at: '2026-11-26T00:00:00.000Z',
              updated_at: '2026-11-26T00:00:00.000Z'
            }
          ]
        })}
        loadManuscriptDetail={async () => approvedDetail}
        loadSettings={async () => ({
          naver_blog_id: 'my_blog_id',
          last_full_export_at: null,
          backup_reminder_due: false,
          days_since_export: null
        })}
        loadDownloadUrls={async () => ({
          expires_in_seconds: 600,
          items: [
            {
              seq: 1,
              r2_key: 'users/owner-uid-1/captures/cap-1/1.webp',
              caption: '아메리카노 잔',
              is_ai_generated: false,
              download_url: 'https://r2.example/1.webp',
              expires_at: '2026-11-26T00:10:00.000Z'
            }
          ]
        })}
        prepareImages={async () => preparedMock}
        exportImages={exportMock}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('link', { name: '네이버 블로그 글쓰기 열기' })).toHaveAttribute(
        'href',
        'https://blog.naver.com/my_blog_id/postwrite'
      );
      expect(screen.getByRole('button', { name: /이미지 1장/ })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /이미지 1장/ }));
    await waitFor(() => {
      expect(exportMock).toHaveBeenCalledTimes(1);
    });
  });

  it('renders actual photo thumbnail and enabled CopyPanel button in ManuscriptPage for approved manuscript', async () => {
    const detail = makeDetail();
    const onOpenCopyPanel = vi.fn();

    renderWithQuery(
      <ManuscriptPage
        listTopics={async () => ({ topics: [detail.topic] })}
        listCaptures={async () => ({ captures: [] })}
        listManuscripts={async () => ({
          manuscripts: [
            {
              manuscript_id: detail.manuscript.manuscript_id,
              topic_id: detail.manuscript.topic_id,
              category_id: detail.category_id,
              content_type: detail.content_type,
              run_id: detail.run_id,
              version: detail.manuscript.version,
              selected_title: detail.manuscript.selected_title,
              content_hash: detail.manuscript.content_hash,
              approved_hash: detail.manuscript.approved_hash,
              approved_at: detail.manuscript.approved_at,
              unresolved_verify_count: 0,
              created_at: '2026-11-26T00:00:00.000Z',
              updated_at: '2026-11-26T00:00:00.000Z'
            }
          ]
        })}
        loadManuscriptDetail={async () => detail}
        loadDownloadUrls={async () => ({
          expires_in_seconds: 600,
          items: [
            {
              seq: 1,
              r2_key: 'users/owner-uid-1/captures/cap-1/1.webp',
              caption: '아메리카노 잔',
              is_ai_generated: false,
              download_url: 'https://r2.example/thumb-1.webp',
              expires_at: '2026-11-26T00:10:00.000Z'
            }
          ]
        })}
        onOpenCopyPanel={onOpenCopyPanel}
      />
    );

    const img = await screen.findByAltText('아메리카노 잔');
    expect(img).toHaveAttribute('src', 'https://r2.example/thumb-1.webp');

    const openCopyBtn = screen.getByRole('button', { name: '수동 복사·공유 패널 열기' });
    expect(openCopyBtn).not.toBeDisabled();
    fireEvent.click(openCopyBtn);
    expect(onOpenCopyPanel).toHaveBeenCalledWith('ms-approved-1');
  });

  it('registers published URL and saves daily visitors in PublishTrackerPage', async () => {
    const postsState: PublishedPostItem[] = [];
    const submitPublishedPost = vi.fn(async (input) => {
      const created: PublishedPostItem = {
        post_id: 'post-1',
        manuscript_id: input.manuscript_id,
        manuscript_title: '성수동 카페 방문 후기',
        category_id: 'cat-cafe',
        category_name: '맛집',
        log_no: input.log_no ?? '223456789012',
        post_url: input.post_url,
        target_keywords: input.target_keywords,
        published_at: '2026-11-26T01:00:00.000Z',
        track_until: '2026-12-26',
        last_tracked_date: '2026-11-26',
        latest_ranks: [
          {
            id: 'r1',
            post_id: 'post-1',
            keyword: '성수카페',
            rank: 4,
            checked_date: '2026-11-26',
            checked_at: '2026-11-26T02:00:00.000Z'
          }
        ],
        rank_history: [
          {
            id: 'r1',
            post_id: 'post-1',
            keyword: '성수카페',
            rank: 4,
            checked_date: '2026-11-26',
            checked_at: '2026-11-26T02:00:00.000Z'
          }
        ]
      };
      postsState.push(created);
      return { post: created };
    });

    const saveVisitor = vi.fn(async (input) => ({
      visitor: {
        visit_date: input.visit_date,
        visitor_count: input.visitor_count,
        updated_at: '2026-11-26T03:00:00.000Z'
      }
    }));

    renderWithQuery(
      <PublishTrackerPage
        listManuscripts={async () => ({
          manuscripts: [
            {
              manuscript_id: 'ms-approved-1',
              topic_id: 'topic-1',
              category_id: 'cat-cafe',
              content_type: 'experience_review',
              run_id: 'run-1',
              version: 2,
              selected_title: '성수동 카페 방문 후기',
              content_hash: HASH_V1,
              approved_hash: HASH_V1,
              approved_at: '2026-11-26T00:05:00.000Z',
              unresolved_verify_count: 0,
              created_at: '2026-11-26T00:00:00.000Z',
              updated_at: '2026-11-26T00:00:00.000Z'
            }
          ]
        })}
        listPublishedPosts={async () => ({ posts: [...postsState] })}
        submitPublishedPost={submitPublishedPost}
        listVisitors={async () => ({ visitors: [] })}
        saveVisitor={saveVisitor}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '발행 URL 등록' })).not.toBeDisabled();
    });

    fireEvent.change(screen.getByLabelText('네이버 블로그 발행 URL'), {
      target: { value: 'https://blog.naver.com/myblog/223456789012' }
    });
    expect(screen.getByText('추출된 logNo: 223456789012')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/추적할 타겟 키워드/), {
      target: { value: '성수카페, 드립커피' }
    });
    fireEvent.click(screen.getByRole('button', { name: '발행 URL 등록' }));

    await waitFor(() => {
      expect(submitPublishedPost).toHaveBeenCalledWith({
        manuscript_id: 'ms-approved-1',
        post_url: 'https://blog.naver.com/myblog/223456789012',
        log_no: '223456789012',
        target_keywords: ['성수카페', '드립커피']
      });
      expect(screen.getByTestId('published-post-223456789012')).toHaveTextContent('성수카페: 4위 (근사치)');
    });

    fireEvent.change(screen.getByLabelText('방문 날짜 (KST)'), {
      target: { value: '2026-11-26' }
    });
    fireEvent.change(screen.getByLabelText('일일 방문자 수'), {
      target: { value: '420' }
    });
    fireEvent.click(screen.getByRole('button', { name: '방문자 수 저장' }));

    await waitFor(() => {
      expect(saveVisitor).toHaveBeenCalledWith({ visit_date: '2026-11-26', visitor_count: 420 });
    });
  });

  it('displays all 4 warnings in DashboardPage (C-Rank, global quota, R2 80%, 30-day backup) and triggers export', async () => {
    const summary: DashboardSummaryResponse = {
      kst_today: '2026-11-26',
      kst_week_start: '2026-11-23',
      approvals: { today_count: 2, week_count: 5, total_approved_count: 10 },
      c_rank: {
        basis: 'published_posts',
        window_days: 30,
        total_count: 6,
        category_count: 3,
        top_category_share: 0.5,
        warning: true,
        warning_reason: '최근 30일 6건이 3개 카테고리에 분산되었고 최다 카테고리 비중이 50%(60% 미만)입니다.',
        categories: [
          { category_id: 'c1', display_name: '테크/IT', count: 3, share: 0.5 },
          { category_id: 'c2', display_name: '맛집', count: 2, share: 0.3333 },
          { category_id: 'c3', display_name: '여행', count: 1, share: 0.1667 }
        ]
      },
      global_quotas: [
        {
          provider: 'gemini_text',
          window_date: '2026-11-25',
          reset_tz: 'America/Los_Angeles',
          reset_at: '2026-11-26T08:00:00.000Z',
          daily_cap: 250,
          used: 215,
          reserved: 0,
          remaining: 35,
          ratio: 0.86,
          warning: true,
          generation_blocked: false
        }
      ],
      d1_warning: {
        warning: false,
        blocked: false,
        reads_ratio: 0.1,
        writes_ratio: 0.1,
        reset_at: '2026-11-27T00:00:00.000Z'
      },
      r2_usage: {
        used_bytes: 9 * 1024 ** 3,
        limit_bytes: 10 * 1024 ** 3,
        ratio: 0.9,
        warning: true,
        source: 'r2_scan_cache',
        updated_at: '2026-11-26T01:00:00.000Z'
      },
      backup: {
        last_full_export_at: '2026-10-15T00:00:00.000Z',
        days_since_export: 42,
        reminder_due: true
      },
      recent_visitors: [
        { visit_date: '2026-11-26', visitor_count: 512, updated_at: '2026-11-26T01:00:00.000Z' }
      ],
      published_count: 6,
      bridge_status: {
        phase: 'M2_PLANNED',
        status: 'BRIDGE_OFFLINE',
        message: 'M2 예정'
      }
    };

    const runExport = vi.fn(
      async (): Promise<ExportResponse> => ({
        exported_at: '2026-11-26T04:00:00.000Z',
        schema_version: '1',
        data: {
          categories: [],
          captures: [],
          topics: [],
          source_snapshots: [],
          manuscripts: [],
          execution_runs: [],
          published_posts: [],
          rank_history: [],
          daily_visitors: [],
          user_meta: []
        }
      })
    );

    renderWithQuery(
      <DashboardPage
        me={BASE_ME}
        d1LimitResetAt={null}
        loadSummary={async () => summary}
        runExport={runExport}
      />
    );

    expect(await screen.findByTestId('warning-c-rank')).toHaveTextContent('C-Rank 주제 분산 경고');
    expect(screen.getByTestId('warning-global-quota')).toHaveTextContent('전체 사용자 공유 한도');
    expect(screen.getByTestId('warning-r2-usage')).toHaveTextContent('90%');
    expect(screen.getByTestId('warning-backup-30d')).toHaveTextContent('42일');

    fireEvent.click(screen.getByRole('button', { name: '지금 전체 JSON 백업하기' }));
    await waitFor(() => {
      expect(runExport).toHaveBeenCalledTimes(1);
    });
  });

  it('validates & saves naver_blog_id, triggers full JSON export, and shows M2 notice in SettingsPage', async () => {
    let settingsState: SettingsResponse = {
      naver_blog_id: null,
      last_full_export_at: '2026-10-20T00:00:00.000Z',
      backup_reminder_due: true,
      days_since_export: 37
    };

    const saveSettings = vi.fn(async (input: { naver_blog_id: string | null }) => {
      settingsState = { ...settingsState, naver_blog_id: input.naver_blog_id };
      return settingsState;
    });
    const runExport = vi.fn(
      async (): Promise<ExportResponse> => ({
        exported_at: '2026-11-26T05:00:00.000Z',
        schema_version: '1',
        data: {
          categories: [],
          captures: [],
          topics: [],
          source_snapshots: [],
          manuscripts: [],
          execution_runs: [],
          published_posts: [],
          rank_history: [],
          daily_visitors: [],
          user_meta: []
        }
      })
    );

    renderWithQuery(
      <SettingsPage
        me={BASE_ME}
        loadSettings={async () => settingsState}
        saveSettings={saveSettings}
        runExport={runExport}
      />
    );

    const input = await screen.findByLabelText('네이버 블로그 ID');
    // Invalid URL injection disables save button and shows alert
    fireEvent.change(input, { target: { value: 'https://evil.com/x' } });
    expect(screen.getByRole('button', { name: '블로그 ID 저장' })).toBeDisabled();

    // Valid ID saves cleanly
    fireEvent.change(input, { target: { value: 'naver_writer_01' } });
    expect(screen.getByText('https://blog.naver.com/naver_writer_01/postwrite')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '블로그 ID 저장' }));

    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith({ naver_blog_id: 'naver_writer_01' });
    });

    fireEvent.click(screen.getByRole('button', { name: /전체 데이터 JSON 내보내기/ }));
    await waitFor(() => {
      expect(runExport).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByRole('heading', { name: /Phase 5 예정/ })).toBeInTheDocument();
  });

  it('clears previous manuscript prepared images immediately when switching from approved manuscript A to B and prevents stale overwrite', async () => {
    const detailA = makeDetail({
      manuscript_id: 'ms-a',
      selected_title: '원고 A',
      content_hash: HASH_V1,
      approved_hash: HASH_V1,
      images: [
        {
          seq: 1,
          r2_key: 'users/owner-uid-1/captures/cap-a/1.webp',
          caption: 'A 사진',
          is_ai_generated: false
        }
      ]
    });
    const detailB = makeDetail({
      manuscript_id: 'ms-b',
      selected_title: '원고 B',
      content_hash: HASH_V2,
      approved_hash: HASH_V2,
      images: [
        {
          seq: 1,
          r2_key: 'users/owner-uid-1/captures/cap-b/1.webp',
          caption: 'B 사진',
          is_ai_generated: false
        }
      ]
    });

    let resolveBPrep!: (items: PreparedShareImage[]) => void;
    const prepareImagesMock = vi.fn(async (items: ReadonlyArray<{ r2_key: string; caption: string }>) => {
      const first = items[0]!;
      if (first.r2_key.includes('cap-a')) {
        return [
          {
            seq: 1,
            caption: 'A 사진',
            r2Key: first.r2_key,
            filename: '01_A_사진.jpg',
            downloadUrl: 'https://r2.example/a.webp',
            jpegFile: new File([new Uint8Array([1])], '01_A_사진.jpg', { type: 'image/jpeg' }),
            status: 'ready' as const
          }
        ];
      }
      return new Promise<PreparedShareImage[]>((resolve) => {
        resolveBPrep = resolve;
      });
    });

    const exportMock = vi.fn(async () => ({ mode: 'sequential_download' as const, count: 1 }));

    renderWithQuery(
      <CopyPanelPage
        listManuscripts={async () => ({
          manuscripts: [
            {
              manuscript_id: 'ms-a',
              topic_id: 'topic-1',
              category_id: 'cat-cafe',
              content_type: 'experience_review',
              run_id: 'run-a',
              version: 1,
              selected_title: '원고 A',
              content_hash: HASH_V1,
              approved_hash: HASH_V1,
              approved_at: '2026-11-26T00:05:00.000Z',
              unresolved_verify_count: 0,
              created_at: '2026-11-26T00:00:00.000Z',
              updated_at: '2026-11-26T00:00:00.000Z'
            },
            {
              manuscript_id: 'ms-b',
              topic_id: 'topic-2',
              category_id: 'cat-cafe',
              content_type: 'experience_review',
              run_id: 'run-b',
              version: 1,
              selected_title: '원고 B',
              content_hash: HASH_V2,
              approved_hash: HASH_V2,
              approved_at: '2026-11-26T00:06:00.000Z',
              unresolved_verify_count: 0,
              created_at: '2026-11-26T00:00:00.000Z',
              updated_at: '2026-11-26T00:00:00.000Z'
            }
          ]
        })}
        loadManuscriptDetail={async (id) => (id === 'ms-b' ? detailB : detailA)}
        loadSettings={async () => ({
          naver_blog_id: null,
          last_full_export_at: null,
          backup_reminder_due: false,
          days_since_export: null
        })}
        loadDownloadUrls={async ({ manuscript_id }) => ({
          expires_in_seconds: 600,
          items: [
            {
              seq: 1,
              r2_key:
                manuscript_id === 'ms-b'
                  ? 'users/owner-uid-1/captures/cap-b/1.webp'
                  : 'users/owner-uid-1/captures/cap-a/1.webp',
              caption: manuscript_id === 'ms-b' ? 'B 사진' : 'A 사진',
              is_ai_generated: false,
              download_url: manuscript_id === 'ms-b' ? 'https://r2.example/b.webp' : 'https://r2.example/a.webp',
              expires_at: '2026-11-26T00:10:00.000Z'
            }
          ]
        })}
        prepareImages={prepareImagesMock}
        exportImages={exportMock}
      />
    );

    // Wait for Manuscript A's image to be ready
    expect(await screen.findByAltText('A 사진')).toHaveAttribute('src', 'https://r2.example/a.webp');

    // Switch to Manuscript B -> A's image must disappear immediately & buttons must be disabled while B prepares
    fireEvent.change(screen.getByLabelText('발행할 원고 선택'), { target: { value: 'ms-b' } });

    await waitFor(() => {
      expect(screen.queryByAltText('A 사진')).toBeNull();
      expect(screen.getByRole('button', { name: 'JPEG 변환 준비 중...' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '개별 JPEG 저장' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'PC PNG 복사 (Ctrl+V)' })).toBeDisabled();
    });

    // Resolve B preparation -> B's image appears and export uses only B's file
    resolveBPrep([
      {
        seq: 1,
        caption: 'B 사진',
        r2Key: 'users/owner-uid-1/captures/cap-b/1.webp',
        filename: '01_B_사진.jpg',
        downloadUrl: 'https://r2.example/b.webp',
        jpegFile: new File([new Uint8Array([2])], '01_B_사진.jpg', { type: 'image/jpeg' }),
        status: 'ready'
      }
    ]);

    expect(await screen.findByAltText('B 사진')).toHaveAttribute('src', 'https://r2.example/b.webp');
    fireEvent.click(screen.getByRole('button', { name: /이미지 1장/ }));

    await waitFor(() => {
      expect(exportMock).toHaveBeenCalledTimes(1);
      const passedImages = (exportMock.mock.calls[0] as unknown[])[0] as PreparedShareImage[];
      expect(passedImages[0]!.filename).toBe('01_B_사진.jpg');
      expect(screen.getByRole('status')).toHaveTextContent('순차 다운로드를 요청했습니다');
    });
  });

  it('refetches manuscript detail on window focus and locks CopyPanelPage if approval was revoked on server', async () => {
    let serverDetail = makeDetail({
      manuscript_id: 'ms-focus-1',
      content_hash: HASH_V1,
      approved_hash: HASH_V1
    });

    const loadDetail = vi.fn(async () => serverDetail);

    renderWithQuery(
      <CopyPanelPage
        listManuscripts={async () => ({
          manuscripts: [
            {
              manuscript_id: 'ms-focus-1',
              topic_id: 'topic-1',
              category_id: 'cat-cafe',
              content_type: 'experience_review',
              run_id: 'run-f',
              version: 1,
              selected_title: serverDetail.manuscript.selected_title,
              content_hash: HASH_V1,
              approved_hash: HASH_V1,
              approved_at: '2026-11-26T00:05:00.000Z',
              unresolved_verify_count: 0,
              created_at: '2026-11-26T00:00:00.000Z',
              updated_at: '2026-11-26T00:00:00.000Z'
            }
          ]
        })}
        loadManuscriptDetail={loadDetail}
        loadSettings={async () => ({
          naver_blog_id: null,
          last_full_export_at: null,
          backup_reminder_due: false,
          days_since_export: null
        })}
        loadDownloadUrls={async () => ({ expires_in_seconds: 600, items: [] })}
        prepareImages={async () => []}
      />
    );

    // Initially approved -> copy buttons enabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '제목 복사' })).not.toBeDisabled();
    });

    // Simulate another tab editing the manuscript -> approval revoked on server
    serverDetail = makeDetail({
      manuscript_id: 'ms-focus-1',
      content_hash: HASH_V2,
      approved_hash: null,
      approved_at: null
    });

    // Window regains focus -> CopyPanelPage refetches & locks copy buttons
    window.dispatchEvent(new Event('focus'));

    await waitFor(() => {
      expect(loadDetail.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByTestId('copy-gate-locked')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '제목 복사' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '서식 유지 본문 복사' })).toBeDisabled();
    });
  });
});
