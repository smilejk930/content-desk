export type YmylCategory =
  | 'finance_stock'
  | 'crypto'
  | 'medical_health'
  | 'legal';

export interface YmylCheckResult {
  blocked: boolean;
  matchedTerms: string[];
  categories: YmylCategory[];
}

const YMYL_KEYWORDS: ReadonlyArray<{ category: YmylCategory; terms: readonly string[] }> = [
  {
    category: 'finance_stock',
    terms: [
      '금융', '투자', '주식', '종목추천', '매수추천', '급등주', '테마주', '선물옵션',
      '투자자문', '리딩방', '재테크', '원금보장', '대출', '신용대출', '카드론',
      '사채', '보험', '실손보험', '암보험', '연금저축추천', '세금', '절세',
      '연말정산', '펀드', 'etf추천', '금융상품', '부동산청약', '주택청약', '청약통장'
    ]
  },
  {
    category: 'crypto',
    terms: [
      '암호화폐', '가상자산', '가상화폐', '코인', '비트코인', '이더리움',
      '알트코인', '디파이', '스테이킹수익', 'nft투자'
    ]
  },
  {
    category: 'medical_health',
    terms: [
      '의료', '의학', '질병', '처방', '처방약', '항생제복용', '질환치료',
      '암치료', '당뇨치료', '고혈압약', '수술방법', '성형수술', '다이어트약',
      '건강검진', '건강기능식품', '영양제치료', '병원추천', '한의원치료',
      '의약품', '임상효능', '증상진단'
    ]
  },
  {
    category: 'legal',
    terms: [
      '법률', '변호사', '소송', '형사고소', '민사소송', '이혼소송',
      '상속분쟁', '손해배상청구', '법적대응', '계약서검토',
      '개인회생', '파산신청', '행정심판'
    ]
  }
];

/**
 * 단독 토큰으로 쓰였을 때만 YMYL로 차단하는 키워드.
 * 예: 카테고리명 "건강" 또는 "건강/운동"은 차단하되, "건강한 개발 습관" 같은 비YMYL 표현은 오탐 방지.
 */
const EXACT_TOKEN_YMYL_KEYWORDS: ReadonlyArray<{ category: YmylCategory; terms: readonly string[] }> = [
  {
    category: 'medical_health',
    terms: ['건강']
  }
];

export function normalizeForYmyl(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function extractTokens(input: string): string[] {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s/,·•|()[\]{}]+/u)
    .map((part) => part.replace(/[\p{P}\p{S}]+/gu, ''))
    .filter((part) => part.length > 0);
}

export function checkYmylPrimary(input: string | readonly string[]): YmylCheckResult {
  const texts = Array.isArray(input) ? input : [input];
  const combined = texts.map(normalizeForYmyl).join(' ');
  const tokens = new Set<string>(texts.flatMap(extractTokens));
  const matchedTerms = new Set<string>();
  const categories = new Set<YmylCategory>();

  for (const group of YMYL_KEYWORDS) {
    for (const term of group.terms) {
      const normalizedTerm = normalizeForYmyl(term);
      if (normalizedTerm.length > 0 && combined.includes(normalizedTerm)) {
        matchedTerms.add(term);
        categories.add(group.category);
      }
    }
  }

  for (const group of EXACT_TOKEN_YMYL_KEYWORDS) {
    for (const term of group.terms) {
      const normalizedTerm = normalizeForYmyl(term);
      if (normalizedTerm.length > 0 && tokens.has(normalizedTerm)) {
        matchedTerms.add(term);
        categories.add(group.category);
      }
    }
  }

  return {
    blocked: matchedTerms.size > 0,
    matchedTerms: [...matchedTerms],
    categories: [...categories]
  };
}
