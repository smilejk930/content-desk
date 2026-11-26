import {
  evaluateNgramSimilarity,
  NGRAM_SIZE,
  NGRAM_WARNING_THRESHOLD,
  type NgramEvaluationResult,
  type NgramReferenceItem
} from '@content-desk/shared';
import type { NgramWorkerRequest, NgramWorkerResponse } from './ngram.worker';

export interface RunNgramOptions {
  threshold?: number;
  createWorker?: () => Worker;
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./ngram.worker.ts', import.meta.url), { type: 'module' });
}

/**
 * 브라우저 Web Worker(ngram.worker.ts)에서 문자 3-gram 유사도를 계산합니다.
 * Worker가 지원되지 않는 환경(테스트 jsdom 등)이나 초기화 실패 시 순수 함수 폴백으로 안전하게 계산합니다.
 */
export async function runNgramSimilarityCheck(
  manuscriptText: string,
  references: readonly NgramReferenceItem[],
  options: RunNgramOptions = {}
): Promise<NgramEvaluationResult> {
  const threshold = options.threshold ?? NGRAM_WARNING_THRESHOLD;

  if (typeof Worker === 'undefined' && !options.createWorker) {
    return evaluateNgramSimilarity(manuscriptText, references, {
      n: NGRAM_SIZE,
      threshold
    });
  }

  let worker: Worker;
  try {
    worker = (options.createWorker ?? defaultCreateWorker)();
  } catch {
    return evaluateNgramSimilarity(manuscriptText, references, {
      n: NGRAM_SIZE,
      threshold
    });
  }

  const requestId = `ngram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<NgramEvaluationResult>((resolve) => {
    const cleanup = () => {
      worker.terminate();
    };

    const fallback = () => {
      cleanup();
      resolve(
        evaluateNgramSimilarity(manuscriptText, references, {
          n: NGRAM_SIZE,
          threshold
        })
      );
    };

    worker.onmessage = (event: MessageEvent<NgramWorkerResponse>) => {
      if (event.data?.requestId !== requestId) return;
      cleanup();
      if (event.data.result) {
        resolve(event.data.result);
      } else {
        resolve(
          evaluateNgramSimilarity(manuscriptText, references, {
            n: NGRAM_SIZE,
            threshold
          })
        );
      }
    };

    worker.onerror = () => {
      fallback();
    };

    const payload: NgramWorkerRequest = {
      requestId,
      manuscriptText,
      references: [...references],
      threshold
    };

    try {
      worker.postMessage(payload);
    } catch {
      fallback();
    }
  });
}
