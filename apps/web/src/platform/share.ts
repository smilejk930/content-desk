import {
  buildSequentialImageFilename,
  type MediaDownloadUrlItem
} from '@content-desk/shared';
import { assertVerifiedCopyGate, type CopyGateInput } from './clipboard';

export interface PreparedShareImage {
  seq: number;
  caption: string;
  r2Key: string;
  filename: string;
  downloadUrl: string;
  jpegFile: File | null;
  status: 'ready' | 'error';
  error?: string;
}

export type BlobImageConverter = (
  sourceBlob: Blob,
  targetMime: 'image/jpeg' | 'image/png',
  quality?: number
) => Promise<Blob>;

/**
 * <canvas>로 WebP/기타 이미지 Blob을 JPEG(공유·다운로드 호환) 또는 PNG(PC 클립보드)로 변환합니다.
 * 변환 직후 canvas 크기 0 초기화 및 Object URL 회수로 메모리를 정리합니다.
 */
export async function convertBlobViaCanvas(
  sourceBlob: Blob,
  targetMime: 'image/jpeg' | 'image/png',
  quality = 0.9
): Promise<Blob> {
  if (sourceBlob.type === targetMime && targetMime === 'image/jpeg') {
    return sourceBlob;
  }

  if (typeof document === 'undefined') {
    throw new Error('브라우저 캔버스 환경이 필요합니다.');
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D 캔버스 컨텍스트를 초기화할 수 없습니다.');
  }

  let width = 0;
  let height = 0;

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(sourceBlob);
    try {
      width = bitmap.width;
      height = bitmap.height;
      canvas.width = width;
      canvas.height = height;
      if (targetMime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(bitmap, 0, 0, width, height);
    } finally {
      bitmap.close();
    }
  } else {
    const objectUrl = URL.createObjectURL(sourceBlob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.crossOrigin = 'anonymous';
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('이미지 디코딩에 실패했습니다.'));
        el.src = objectUrl;
      });
      width = img.naturalWidth || img.width;
      height = img.naturalHeight || img.height;
      canvas.width = width;
      canvas.height = height;
      if (targetMime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(img, 0, 0, width, height);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  try {
    const outBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), targetMime, targetMime === 'image/jpeg' ? quality : undefined);
    });
    if (!outBlob) {
      throw new Error(`${targetMime} 변환에 실패했습니다.`);
    }
    return outBlob;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * 복사 패널 진입 시 R2 서명 URL로 이미지를 미리 내려받아 JPEG(01_캡션.jpg) File 목록으로 준비합니다.
 * (Chrome Web Share API의 사용자 클릭 후 약 5초 제스처 제한을 피하기 위함)
 */
export async function prepareShareImagesFromDownloadUrls(
  items: readonly MediaDownloadUrlItem[],
  options?: {
    fetchImpl?: typeof fetch;
    convertBlob?: BlobImageConverter;
  }
): Promise<PreparedShareImage[]> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const convertBlob = options?.convertBlob ?? convertBlobViaCanvas;
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  const prepared: PreparedShareImage[] = [];

  for (const item of sorted) {
    const filename = buildSequentialImageFilename(item.seq, item.caption, 'jpg');
    try {
      const res = await fetchImpl(item.download_url, { mode: 'cors' });
      if (!res.ok) {
        throw new Error(`이미지 다운로드 실패 (HTTP ${res.status})`);
      }
      const rawBlob = await res.blob();
      const jpegBlob = await convertBlob(rawBlob, 'image/jpeg', 0.9);
      const jpegFile = new File([jpegBlob], filename, { type: 'image/jpeg' });
      prepared.push({
        seq: item.seq,
        caption: item.caption,
        r2Key: item.r2_key,
        filename,
        downloadUrl: item.download_url,
        jpegFile,
        status: 'ready'
      });
    } catch (err) {
      prepared.push({
        seq: item.seq,
        caption: item.caption,
        r2Key: item.r2_key,
        filename,
        downloadUrl: item.download_url,
        jpegFile: null,
        status: 'error',
        error: err instanceof Error ? err.message : '이미지 변환 준비 실패'
      });
    }
  }

  return prepared;
}

export function canWebShareFiles(files: readonly File[]): boolean {
  if (files.length === 0) return false;
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') {
    return false;
  }
  try {
    return navigator.canShare({ files: [...files] });
  } catch {
    return false;
  }
}

export const DOWNLOAD_REVOKE_DELAY_MS = 10_000;
export const SEQUENTIAL_DOWNLOAD_DELAY_MS = 250;

export function triggerSingleFileDownload(
  file: File,
  revokeDelayMs = DOWNLOAD_REVOKE_DELAY_MS
): void {
  const objectUrl = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = file.name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), Math.max(5_000, revokeDelayMs));
}

/**
 * 준비 완료된 JPEG 이미지 목록을 내보냅니다.
 * - 클릭 직후 동기적으로 navigator.canShare({ files }) -> navigator.share({ files }) 호출
 * - 미지원 브라우저에서는 ZIP 라이브러리 없이 개별 JPEG 파일을 짧은 지연(기본 250ms) 간격으로
 *   순차 다운로드 요청합니다.
 */
export function exportPreparedImages(
  images: readonly PreparedShareImage[],
  gate: CopyGateInput,
  options?: {
    title?: string;
    downloadFile?: (file: File) => void;
    sequentialDelayMs?: number;
  }
): Promise<{ mode: 'web_share' | 'sequential_download'; count: number }> {
  assertVerifiedCopyGate(gate);

  const readyFiles = images
    .map((img) => img.jpegFile)
    .filter((file): file is File => file !== null);

  if (readyFiles.length === 0) {
    return Promise.reject(new Error('내보낼 수 있는 준비된 이미지가 없습니다.'));
  }

  if (canWebShareFiles(readyFiles)) {
    // 사용자 클릭 핸들러 안에서 사전 await 없이 즉시 navigator.share 호출
    return navigator
      .share({
        files: readyFiles,
        title: options?.title ?? 'Content Desk 이미지'
      })
      .then(() => ({
        mode: 'web_share' as const,
        count: readyFiles.length
      }));
  }

  const downloadFn = options?.downloadFile ?? triggerSingleFileDownload;
  const delayMs = options?.sequentialDelayMs ?? SEQUENTIAL_DOWNLOAD_DELAY_MS;

  return (async () => {
    for (let i = 0; i < readyFiles.length; i += 1) {
      if (i > 0 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      downloadFn(readyFiles[i]!);
    }
    return {
      mode: 'sequential_download' as const,
      count: readyFiles.length
    };
  })();
}

/**
 * PC 스마트에디터 ONE Ctrl+V 붙여넣기용 개별 이미지 image/png 클립보드 복사.
 */
export function copySingleImageAsPngToClipboard(
  image: PreparedShareImage,
  gate: CopyGateInput,
  options?: { convertBlob?: BlobImageConverter }
): Promise<void> {
  assertVerifiedCopyGate(gate);

  if (!image.jpegFile) {
    return Promise.reject(new Error('이미지 변환이 완료되지 않았습니다.'));
  }
  if (
    typeof navigator === 'undefined' ||
    !navigator.clipboard?.write ||
    typeof ClipboardItem === 'undefined'
  ) {
    return Promise.reject(new Error('이미지 클립보드 복사를 지원하지 않는 브라우저입니다.'));
  }

  const convertBlob = options?.convertBlob ?? convertBlobViaCanvas;
  const pngBlobPromise = convertBlob(image.jpegFile, 'image/png');
  const item = new ClipboardItem({
    'image/png': pngBlobPromise
  });

  // 클릭 핸들러 내 동기 호출
  return navigator.clipboard.write([item]);
}
