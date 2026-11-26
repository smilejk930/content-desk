import fs from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CaptureAsset,
  CapturePresignRequest,
  CategoryProfile,
  CreateCaptureRequest,
  MeResponse
} from '@content-desk/shared';
import { ApiRequestError } from '../src/lib/api-client';
import { ImageEncodeError } from '../src/platform/image-encode';
import { CategoriesPage } from '../src/pages/CategoriesPage';
import { MobileUploadPage } from '../src/pages/MobileUploadPage';
import { Phase1HomePage } from '../src/pages/Phase1HomePage';

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

const SAMPLE_CATEGORIES: CategoryProfile[] = [
  {
    category_id: 'cat-food-1',
    display_name: '맛집 탐방',
    naver_board_name: '성수 맛집',
    discovery_mode: 'experience_first',
    datalab_anchor_keyword: '성수동 맛집',
    seed_keywords: ['브런치'],
    primary_source_domains: [],
    default_media_policy: {
      allowed_content_types: ['experience_review'],
      min_real_photos: 1,
      require_field_memo: true
    },
    default_visibility: '전체공개',
    created_at: '2026-11-26T00:00:00.000Z',
    updated_at: '2026-11-26T00:00:00.000Z'
  },
  {
    category_id: 'cat-vlog-1',
    display_name: '일상/브이로그',
    naver_board_name: '일상기록',
    discovery_mode: 'none',
    datalab_anchor_keyword: null,
    seed_keywords: [],
    primary_source_domains: [],
    default_media_policy: {
      allowed_content_types: ['vlog'],
      min_real_photos: 0,
      require_field_memo: true
    },
    default_visibility: '이웃공개',
    created_at: '2026-11-26T00:00:00.000Z',
    updated_at: '2026-11-26T00:00:00.000Z'
  }
];

describe('CategoriesPage (카테고리 CRUD · 조합표 UI · YMYL 차단 안내)', () => {
  it('constrains allowed content types by discovery_mode, creates a category, and shows YMYL block alert', async () => {
    let categoriesState = [...SAMPLE_CATEGORIES];
    const addMock = vi.fn(async (input) => {
      if (input.display_name.includes('주식')) {
        throw new ApiRequestError(
          422,
          'YMYL_BLOCKED',
          'YMYL 금지 주제(주식)는 등록할 수 없습니다.'
        );
      }
      const created: CategoryProfile = {
        ...input,
        category_id: 'cat-new-1',
        created_at: '2026-11-26T01:00:00.000Z',
        updated_at: '2026-11-26T01:00:00.000Z'
      };
      categoriesState = [created, ...categoriesState];
      return { category: created };
    });

    renderWithQuery(
      <CategoriesPage
        listCategories={async () => ({ categories: [...categoriesState] })}
        addCategory={addMock}
        editCategory={vi.fn()}
        removeCategory={vi.fn()}
      />
    );

    expect(await screen.findByTestId('category-row-cat-food-1')).toBeInTheDocument();

    // Switch discovery_mode to 'none' -> only vlog checkbox should be shown and anchor hidden
    fireEvent.change(screen.getByLabelText(/글감 발굴 방식/), { target: { value: 'none' } });
    expect(screen.getByLabelText(/일상\/브이로그 \(vlog\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/데이터랩 기준 키워드/)).toBeNull();

    // Submit YMYL blocked category -> alert shown
    fireEvent.change(screen.getByLabelText('카테고리 표시명'), { target: { value: '주식 투자' } });
    fireEvent.change(screen.getByLabelText('네이버 블로그 게시판명'), { target: { value: '재테크' } });
    fireEvent.click(screen.getByRole('button', { name: '카테고리 추가' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('YMYL 금지 주제');
    });

    // Submit valid non-YMYL vlog category -> added to list
    fireEvent.change(screen.getByLabelText('카테고리 표시명'), { target: { value: '주말 산책' } });
    fireEvent.change(screen.getByLabelText('네이버 블로그 게시판명'), { target: { value: '산책일기' } });
    fireEvent.click(screen.getByRole('button', { name: '카테고리 추가' }));

    await waitFor(() => {
      expect(screen.getByTestId('category-row-cat-new-1')).toBeInTheDocument();
    });
  });
});

describe('MobileUploadPage (전처리 · presign · R2 PUT · 메모 단독 · LLM 동의 · 메타데이터 목록)', () => {
  it('processes photo via EXIF + encode -> presign -> R2 PUT -> POST /api/captures, and records LLM consent', async () => {
    const capturesState: CaptureAsset[] = [];
    const extractExif = vi.fn(async () => ({
      takenAt: '2026-11-26T14:00:00+09:00',
      orientation: 1
    }));
    const encodedBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const encodeImage = vi.fn(async () => ({
      blob: encodedBlob,
      contentType: 'image/webp' as const,
      width: 1600,
      height: 1200,
      byteSize: encodedBlob.size
    }));
    const requestPresign = vi.fn(async (req: CapturePresignRequest) => ({
      capture_id: req.capture_id,
      expires_in_seconds: 300,
      uploads: req.files.map((f) => ({
        seq: f.seq,
        r2_key: `users/u1/captures/${req.capture_id}/${f.seq}.webp`,
        content_type: f.content_type,
        upload_url: `https://test-account.r2.cloudflarestorage.com/bucket/users/u1/captures/${req.capture_id}/${f.seq}.webp?X-Amz-Signature=abc`,
        expires_at: '2026-11-26T00:05:00.000Z'
      }))
    }));
    const uploadToR2 = vi.fn(async () => undefined);
    const submitCapture = vi.fn(async (input: CreateCaptureRequest) => {
      const created: CaptureAsset = {
        capture_id: input.capture_id ?? 'cap-1',
        category_id: input.category_id,
        content_type: input.content_type,
        photos: input.photos ?? [],
        field_memo: input.field_memo ?? '',
        sponsorship: input.sponsorship ?? { is_sponsored: false },
        store_location_consent: false,
        llm_consent_at: null,
        created_at: '2026-11-26T02:00:00.000Z',
        updated_at: '2026-11-26T02:00:00.000Z'
      };
      capturesState.unshift(created);
      return { capture: created };
    });
    const submitConsent = vi.fn(async (id) => {
      const target = capturesState.find((c) => c.capture_id === id)!;
      target.llm_consent_at = '2026-11-26T02:05:00.000Z';
      return { capture: { ...target } };
    });

    renderWithQuery(
      <MobileUploadPage
        listCategories={async () => ({ categories: SAMPLE_CATEGORIES })}
        listCaptures={async () => ({ captures: [...capturesState] })}
        extractExif={extractExif}
        encodeImage={encodeImage}
        requestPresign={requestPresign}
        uploadToR2={uploadToR2}
        submitCapture={submitCapture}
        submitConsent={submitConsent}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText('카테고리')).toHaveValue('cat-food-1');
    });

    // Attach photo + memo
    const fileInput = screen.getByLabelText(/실사 사진 선택/);
    const photoFile = new File([new Uint8Array([0xff, 0xd8])], 'latte.jpg', {
      type: 'image/jpeg'
    });
    fireEvent.change(fileInput, { target: { files: [photoFile] } });
    fireEvent.change(screen.getByLabelText('사진 1 캡션'), { target: { value: '라떼 아트' } });
    fireEvent.change(screen.getByLabelText(/현장 메모/), {
      target: { value: '성수동 카페 라떼가 고소했다.' }
    });

    fireEvent.click(screen.getByRole('button', { name: '자료 올리기' }));

    await waitFor(() => {
      expect(extractExif).toHaveBeenCalledTimes(1);
      expect(encodeImage).toHaveBeenCalledTimes(1);
      expect(requestPresign).toHaveBeenCalledTimes(1);
      expect(uploadToR2).toHaveBeenCalledWith(
        expect.stringContaining('X-Amz-Signature='),
        encodedBlob,
        'image/webp',
        encodedBlob.size
      );
      expect(submitCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          photos: [
            expect.objectContaining({
              seq: 1,
              mime_type: 'image/webp',
              byte_size: encodedBlob.size
            })
          ]
        })
      );
    });

    // Metadata list should show the new capture and allow clicking LLM consent
    const consentBtn = await screen.findByRole('button', { name: '무료 LLM 전송 동의' });
    fireEvent.click(consentBtn);

    await waitFor(() => {
      expect(submitConsent).toHaveBeenCalledTimes(1);
      expect(screen.getByText('LLM 전송 동의됨')).toBeInTheDocument();
    });
  });

  it('allows memo-only submission without presign/R2 upload and aborts completely when image encoding fails', async () => {
    const requestPresign = vi.fn();
    const uploadToR2 = vi.fn();
    const submitCapture = vi.fn(async (input) => ({
      capture: {
        capture_id: input.capture_id ?? 'cap-memo',
        category_id: input.category_id,
        content_type: input.content_type,
        photos: [],
        field_memo: input.field_memo ?? '',
        sponsorship: { is_sponsored: false },
        store_location_consent: false as const,
        llm_consent_at: null,
        created_at: '2026-11-26T02:00:00.000Z',
        updated_at: '2026-11-26T02:00:00.000Z'
      }
    }));

    const encodeFail = vi.fn(async () => {
      throw new ImageEncodeError(
        'DECODE_FAILED',
        'HEIF 변환 실패 - 원본 EXIF 보호를 위해 업로드를 차단했습니다.'
      );
    });

    renderWithQuery(
      <MobileUploadPage
        listCategories={async () => ({ categories: SAMPLE_CATEGORIES })}
        listCaptures={async () => ({ captures: [] })}
        extractExif={async () => ({ takenAt: null, orientation: null })}
        encodeImage={encodeFail}
        requestPresign={requestPresign}
        uploadToR2={uploadToR2}
        submitCapture={submitCapture}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText('카테고리')).toHaveValue('cat-food-1');
    });

    // 1) Memo-only (0 photos) -> succeeds without presign/R2
    fireEvent.change(screen.getByLabelText(/현장 메모/), {
      target: { value: '사진 없이 메모만 단독 저장합니다.' }
    });
    fireEvent.click(screen.getByRole('button', { name: '자료 올리기' }));

    await waitFor(() => {
      expect(submitCapture).toHaveBeenCalledTimes(1);
    });
    expect(requestPresign).not.toHaveBeenCalled();
    expect(uploadToR2).not.toHaveBeenCalled();

    // 2) Photo with failing encoder -> aborts with alert, never calls presign/R2/submitCapture again
    const badFile = new File([new Uint8Array([1, 2])], 'broken.heic', { type: 'image/heic' });
    fireEvent.change(screen.getByLabelText(/실사 사진 선택/), { target: { files: [badFile] } });
    fireEvent.click(screen.getByRole('button', { name: '자료 올리기' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('원본 EXIF 보호를 위해 업로드를 차단');
    });
    expect(requestPresign).not.toHaveBeenCalled();
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(submitCapture).toHaveBeenCalledTimes(1);
  });
});

describe('Phase1HomePage 내비게이션 & _headers R2 CSP', () => {
  const baseMe: MeResponse = {
    uid: 'user-1',
    email: 'user1@example.com',
    role: 'user',
    auth_time: 1732000000,
    session_expires_at: '2026-12-04T00:00:00.000Z',
    reauth_valid_until: '2026-11-26T00:15:00.000Z',
    d1_connected: true
  };

  it('navigates between 홈, 카테고리, and 자료 올리기 tabs for normal users', async () => {
    renderWithQuery(
      <Phase1HomePage
        user={{ uid: 'user-1' }}
        d1LimitResetAt={null}
        loadMe={async () => baseMe}
        onSignOut={vi.fn()}
        categoriesPageProps={{
          listCategories: async () => ({ categories: SAMPLE_CATEGORIES })
        }}
        uploadPageProps={{
          listCategories: async () => ({ categories: SAMPLE_CATEGORIES }),
          listCaptures: async () => ({ captures: [] })
        }}
      />
    );

    const nav = await screen.findByRole('navigation', { name: '주 메뉴' });
    fireEvent.click(within(nav).getByRole('button', { name: '카테고리' }));
    expect(await screen.findByText('비YMYL 카테고리 등록')).toBeInTheDocument();

    fireEvent.click(within(nav).getByRole('button', { name: '자료 올리기' }));
    expect(await screen.findByText('현장 사진·메모 올리기')).toBeInTheDocument();
  });

  it('includes R2 direct upload wildcard origin in public/_headers CSP connect-src', () => {
    const headersPath = path.resolve(import.meta.dirname, '..', 'public', '_headers');
    const content = fs.readFileSync(headersPath, 'utf8');
    expect(content).toMatch(/connect-src[^;]*https:\/\/\*\.r2\.cloudflarestorage\.com/);
  });
});
