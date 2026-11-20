import { describe, expect, it } from 'vitest';
import {
  buildAiImageDisclosure,
  buildFtcDisclosure,
  buildSequentialImageFilename,
  formatImageMarker,
  splitManuscriptByImageMarkers
} from '../src/index.js';

describe('manuscript domain helpers', () => {
  it('splits body around image markers consistently', () => {
    const body = `<p>첫 문단</p>${formatImageMarker(1, '매장 외관')}<p>둘째 문단</p>${formatImageMarker(2, '라떼')}`;
    const segments = splitManuscriptByImageMarkers(body);
    expect(segments).toEqual([
      { type: 'text', content: '<p>첫 문단</p>' },
      { type: 'image_marker', content: '[📷 이미지 1 삽입 위치: 매장 외관]', imageIndex: 1, caption: '매장 외관' },
      { type: 'text', content: '<p>둘째 문단</p>' },
      { type: 'image_marker', content: '[📷 이미지 2 삽입 위치: 라떼]', imageIndex: 2, caption: '라떼' }
    ]);
  });

  it('builds safe zero-padded sequential filenames', () => {
    expect(buildSequentialImageFilename(1, '시그니처 라떼 / 샷 추가')).toBe('01_시그니처_라떼_샷_추가.jpg');
    expect(buildSequentialImageFilename(12, '   ')).toBe('12_image.jpg');
  });

  it('generates FTC and AI disclosures when required', () => {
    expect(buildFtcDisclosure({ is_sponsored: false })).toBeNull();
    expect(
      buildFtcDisclosure({ is_sponsored: true, provider_name: 'OO카페', compensation_type: '음료 무상 제공' })
    ).toContain('OO카페');
    expect(buildAiImageDisclosure(false)).toBeNull();
    expect(buildAiImageDisclosure(true)).toContain('AI');
  });
});
