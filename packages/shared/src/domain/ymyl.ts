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
      '주식', '종목추천', '매수추천', '급등주', '테마주', '선물옵션',
      '투자자문', '리딩방', '재테크수익보장', '원금보장', '대출',
      '신용대출', '카드론', '사채', '보험추천', '실손보험', '암보험',
      '연금저축추천', '절세편법', '펀드추천', 'etf추천', '금융상품'
    ]
  },
  {
    category: 'crypto',
    terms: [
      '암호화폐', '가상자산', '가상화폐', '비트코인', '이더리움',
      '알트코인', '코인추천', '코인리딩', '디파이', '스테이킹수익', 'nft투자'
    ]
  },
  {
    category: 'medical_health',
    terms: [
      '의학진단', '처방약', '항생제복용', '질병치료', '암치료', '당뇨치료',
      '고혈압약', '수술방법', '성형수술', '다이어트약', '건강기능식품효능',
      '영양제치료', '병원추천', '한의원치료', '의료행위', '임상효능', '증상진단'
    ]
  },
  {
    category: 'legal',
    terms: [
      '법률상담', '변호사선임', '소송방법', '형사고소', '민사소송',
      '이혼소송', '상속분쟁', '손해배상청구', '법적대응', '계약서검토',
      '개인회생', '파산신청', '행정심판'
    ]
  }
];

export function normalizeForYmyl(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function checkYmylPrimary(input: string | readonly string[]): YmylCheckResult {
  const texts = Array.isArray(input) ? input : [input];
  const combined = texts.map(normalizeForYmyl).join(' ');
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

  return {
    blocked: matchedTerms.size > 0,
    matchedTerms: [...matchedTerms],
    categories: [...categories]
  };
}
