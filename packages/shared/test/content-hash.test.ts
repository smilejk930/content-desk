import { describe, expect, it } from 'vitest';
import { computeContentHash, type ContentHashInput } from '../src/index.js';

const baseInput: ContentHashInput = {
  selected_title: '성수동 카페 솔직 후기',
  body_html: '<p>본문입니다.</p><p>[📷 이미지 1 삽입 위치: 외관]</p>',
  images: [
    { seq: 2, r2_key: 'captures/c1/02.webp', caption: '내부', is_ai_generated: false },
    { seq: 1, r2_key: 'captures/c1/01.webp', caption: '외관', is_ai_generated: false }
  ],
  tags: ['성수카페', '커피'],
  sponsorship: { is_sponsored: false },
  ftc_disclosure: null,
  ai_disclosure: null,
  visibility: '전체공개',
  naver_board_name: '맛집'
};

describe('computeContentHash', () => {
  it('produces identical SHA-256 hash regardless of image array order', async () => {
    const h1 = await computeContentHash(baseInput);
    const h2 = await computeContentHash({
      ...baseInput,
      images: [...baseInput.images].reverse()
    });
    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);
  });

  it('changes hash when any substantive field changes', async () => {
    const h1 = await computeContentHash(baseInput);
    const h2 = await computeContentHash({
      ...baseInput,
      selected_title: '성수동 카페 솔직 후기 수정본'
    });
    expect(h1).not.toBe(h2);
  });
});
