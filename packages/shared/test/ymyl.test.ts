import { describe, expect, it } from 'vitest';
import { checkYmylPrimary } from '../src/index.js';

describe('checkYmylPrimary', () => {
  it('blocks finance, crypto, medical, and legal keywords even with whitespace or symbols', () => {
    expect(checkYmylPrimary('주 식 / 급 등 주 추천').blocked).toBe(true);
    expect(checkYmylPrimary('비트-코인 투자').categories).toContain('crypto');
    expect(checkYmylPrimary('당뇨 치료 방법').categories).toContain('medical_health');
    expect(checkYmylPrimary('이혼 소송 절차').categories).toContain('legal');
  });

  it('allows non-YMYL topics such as tech, cafes, and travel without false-positiving "건강한 개발 습관"', () => {
    const res = checkYmylPrimary([
      '테크/IT',
      '성수동 카페 투어',
      'Cloudflare Workers 무료 플랜',
      '건강한 개발 습관'
    ]);
    expect(res.blocked).toBe(false);
    expect(res.matchedTerms).toHaveLength(0);
  });

  it('blocks exact token "건강", medical/prescription, tax, insurance, and real-estate subscription terms', () => {
    expect(checkYmylPrimary('건강').blocked).toBe(true);
    expect(checkYmylPrimary('건강/의료').blocked).toBe(true);
    expect(checkYmylPrimary('처방전 발급 안내').blocked).toBe(true);
    expect(checkYmylPrimary('부동산 청약 당첨 전략').blocked).toBe(true);
    expect(checkYmylPrimary('종합소득세 세금 신고').blocked).toBe(true);
    expect(checkYmylPrimary('여행자 보험 비교').blocked).toBe(true);
  });
});
