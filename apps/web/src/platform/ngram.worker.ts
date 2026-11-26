import {
  evaluateNgramSimilarity,
  NGRAM_SIZE,
  NGRAM_WARNING_THRESHOLD,
  type NgramEvaluationResult,
  type NgramReferenceItem
} from '@content-desk/shared';

export interface NgramWorkerRequest {
  requestId: string;
  manuscriptText: string;
  references: NgramReferenceItem[];
  threshold?: number;
}

export interface NgramWorkerResponse {
  requestId: string;
  result?: NgramEvaluationResult;
  error?: string;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<NgramWorkerRequest>) => void) | null;
  postMessage: (message: NgramWorkerResponse) => void;
};

workerScope.onmessage = (event: MessageEvent<NgramWorkerRequest>) => {
  const { requestId, manuscriptText, references, threshold } = event.data;
  try {
    const result = evaluateNgramSimilarity(manuscriptText, references, {
      n: NGRAM_SIZE,
      threshold: threshold ?? NGRAM_WARNING_THRESHOLD
    });
    workerScope.postMessage({ requestId, result });
  } catch (err) {
    workerScope.postMessage({
      requestId,
      error: err instanceof Error ? err.message : 'N-gram 유사도 계산 중 오류가 발생했습니다.'
    });
  }
};
