export const NGRAM_SIZE = 3;
export const NGRAM_WARNING_THRESHOLD = 0.3;

export interface NgramReferenceItem {
  id: string;
  kind: 'past_manuscript' | 'serp_snippet';
  label: string;
  text: string;
}

export interface NgramMatchItem {
  id: string;
  kind: 'past_manuscript' | 'serp_snippet';
  label: string;
  similarity: number;
  warning: boolean;
}

export interface NgramEvaluationResult {
  ngramSize: number;
  threshold: number;
  maxSimilarity: number;
  warning: boolean;
  matches: NgramMatchItem[];
}

function stripTagsAndEntities(input: string): string {
  return input
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/**
 * 문자 3-gram 대조용 정규화:
 * HTML 태그·제어문자·공백을 제거하고 NFKC + 소문자로 통일합니다.
 */
export function normalizeTextForNgram(input: string): string {
  return stripTagsAndEntities(input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, '');
}

export function extractCharNgrams(input: string, n = NGRAM_SIZE): Set<string> {
  const normalized = normalizeTextForNgram(input);
  const grams = new Set<string>();
  if (n <= 0 || normalized.length < n) {
    return grams;
  }
  for (let i = 0; i <= normalized.length - n; i += 1) {
    grams.add(normalized.slice(i, i + n));
  }
  return grams;
}

/**
 * 문자 3-gram 유사도 계산 (Overlap/Containment 계수: |A ∩ B| / min(|A|, |B|)).
 * 짧은 SERP 스니펫(약 100자)이 긴 원고(2,000자)에 그대로 복사된 경우에도
 * 30% 이상 경고를 정확히 탐지하고, 두 원고가 동일할 때 1.0을 반환합니다.
 */
export function computeCharNgramSimilarity(
  textA: string,
  textB: string,
  n = NGRAM_SIZE
): number {
  const gramsA = extractCharNgrams(textA, n);
  const gramsB = extractCharNgrams(textB, n);
  const minSize = Math.min(gramsA.size, gramsB.size);
  if (minSize === 0) return 0;

  const [smaller, larger] = gramsA.size <= gramsB.size ? [gramsA, gramsB] : [gramsB, gramsA];
  let intersection = 0;
  for (const gram of smaller) {
    if (larger.has(gram)) {
      intersection += 1;
    }
  }
  return Number((intersection / minSize).toFixed(4));
}

export function evaluateNgramSimilarity(
  manuscriptText: string,
  references: readonly NgramReferenceItem[],
  options?: { n?: number; threshold?: number }
): NgramEvaluationResult {
  const n = options?.n ?? NGRAM_SIZE;
  const threshold = options?.threshold ?? NGRAM_WARNING_THRESHOLD;
  const sourceGrams = extractCharNgrams(manuscriptText, n);

  const matches: NgramMatchItem[] = [];
  let maxSimilarity = 0;

  for (const ref of references) {
    const refGrams = extractCharNgrams(ref.text, n);
    const minSize = Math.min(sourceGrams.size, refGrams.size);
    let similarity = 0;
    if (minSize > 0) {
      const [smaller, larger] =
        sourceGrams.size <= refGrams.size ? [sourceGrams, refGrams] : [refGrams, sourceGrams];
      let intersection = 0;
      for (const gram of smaller) {
        if (larger.has(gram)) {
          intersection += 1;
        }
      }
      similarity = Number((intersection / minSize).toFixed(4));
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }

    matches.push({
      id: ref.id,
      kind: ref.kind,
      label: ref.label,
      similarity,
      warning: similarity >= threshold
    });
  }

  matches.sort((a, b) => b.similarity - a.similarity);

  return {
    ngramSize: n,
    threshold,
    maxSimilarity,
    warning: maxSimilarity >= threshold,
    matches
  };
}
