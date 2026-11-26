import { MAX_CAPTURE_FILE_BYTES, type CaptureUploadMime } from '@content-desk/shared';
import type { ImageWorkerRequest, ImageWorkerResponse } from './image.worker';

export const MAX_IMAGE_LONG_EDGE = 2560;
export const DEFAULT_WEBP_QUALITY = 0.82;
export const DEFAULT_JPEG_QUALITY = 0.82;

export class ImageEncodeError extends Error {
  readonly code: 'DECODE_FAILED' | 'ENCODE_FAILED' | 'FILE_TOO_LARGE';

  constructor(code: 'DECODE_FAILED' | 'ENCODE_FAILED' | 'FILE_TOO_LARGE', message: string) {
    super(message);
    this.name = 'ImageEncodeError';
    this.code = code;
  }
}

export interface EncodedCaptureImage {
  blob: Blob;
  contentType: CaptureUploadMime;
  width: number;
  height: number;
  byteSize: number;
}

export interface ImageEncodeOptions {
  maxLongEdge?: number;
  webpQuality?: number;
  jpegQuality?: number;
  probeDimensions?: (blob: Blob) => Promise<{ width: number; height: number }>;
  runWorker?: (req: Omit<ImageWorkerRequest, 'id'>) => Promise<EncodedCaptureImage>;
  encodeMainThread?: (
    blob: Blob,
    targetWidth: number,
    targetHeight: number,
    webpQuality: number,
    jpegQuality: number
  ) => Promise<EncodedCaptureImage>;
}

export function computeTargetDimensions(
  naturalWidth: number,
  naturalHeight: number,
  maxLongEdge = MAX_IMAGE_LONG_EDGE
): { width: number; height: number } {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    throw new ImageEncodeError(
      'DECODE_FAILED',
      '사진 크기를 읽을 수 없습니다. 원본 보호를 위해 업로드를 차단했습니다. 카메라 설정에서 "높은 호환성(JPEG)" 형식을 확인해 주세요.'
    );
  }

  const longEdge = Math.max(naturalWidth, naturalHeight);
  if (longEdge <= maxLongEdge) {
    return {
      width: Math.round(naturalWidth),
      height: Math.round(naturalHeight)
    };
  }

  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale))
  };
}

async function probeImageDimensionsViaImg(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof URL === 'undefined' || typeof Image === 'undefined') {
    throw new ImageEncodeError(
      'DECODE_FAILED',
      '브라우저 이미지 디코더를 사용할 수 없어 원본 업로드를 차단했습니다.'
    );
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        reject(
          new ImageEncodeError(
            'DECODE_FAILED',
            '이미지 디코딩에 실패했습니다(HEIF/HEIC 미지원 가능). 원본 EXIF 보호를 위해 업로드를 차단했습니다. 카메라 설정을 "높은 호환성(JPEG)"으로 변경해 주세요.'
          )
        );
      };
      img.src = objectUrl;
    });
    return dims;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function encodeOnMainThreadDefault(
  blob: Blob,
  targetWidth: number,
  targetHeight: number,
  webpQuality: number,
  jpegQuality: number
): Promise<EncodedCaptureImage> {
  if (typeof document === 'undefined') {
    throw new ImageEncodeError(
      'ENCODE_FAILED',
      '캔버스 재인코딩을 지원하지 않는 환경입니다. 원본 업로드를 차단했습니다.'
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  let bitmap: ImageBitmap | null = null;
  let objectUrl: string | null = null;

  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new ImageEncodeError(
        'ENCODE_FAILED',
        '2D 캔버스를 초기화할 수 없어 원본 업로드를 차단했습니다.'
      );
    }

    if (typeof createImageBitmap === 'function') {
      try {
        const resized = await createImageBitmap(blob, {
          imageOrientation: 'from-image',
          resizeWidth: targetWidth,
          resizeHeight: targetHeight,
          resizeQuality: 'high'
        });
        if (
          Math.abs(resized.width - targetWidth) <= 1 &&
          Math.abs(resized.height - targetHeight) <= 1
        ) {
          bitmap = resized;
        } else {
          resized.close();
          bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        }
      } catch {
        bitmap = null;
      }
    }

    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    } else {
      objectUrl = URL.createObjectURL(blob);
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () =>
          reject(
            new ImageEncodeError(
              'DECODE_FAILED',
              '사진을 캔버스로 불러오지 못했습니다. 카메라 설정에서 "높은 호환성(JPEG)"으로 변경해 주세요.'
            )
          );
        el.src = objectUrl!;
      });
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    }

    let encoded = await canvasToBlob(canvas, 'image/webp', webpQuality);
    if (!encoded || encoded.type !== 'image/webp' || encoded.size === 0) {
      encoded = await canvasToBlob(canvas, 'image/jpeg', jpegQuality);
    }

    if (
      !encoded ||
      (encoded.type !== 'image/webp' && encoded.type !== 'image/jpeg') ||
      encoded.size === 0
    ) {
      throw new ImageEncodeError(
        'ENCODE_FAILED',
        'WebP/JPEG 재인코딩에 실패하여 원본 업로드를 차단했습니다. 카메라 호환성 설정을 확인해 주세요.'
      );
    }

    return {
      blob: encoded,
      contentType: encoded.type,
      width: targetWidth,
      height: targetHeight,
      byteSize: encoded.size
    };
  } finally {
    if (bitmap) {
      bitmap.close();
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    canvas.width = 0;
    canvas.height = 0;
  }
}

let workerInstance: Worker | null = null;
let workerReqSeq = 0;
let sequentialLock: Promise<void> = Promise.resolve();

function canUseImageWorker(): boolean {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

function runInSharedWorker(req: Omit<ImageWorkerRequest, 'id'>): Promise<EncodedCaptureImage> {
  if (!workerInstance) {
    workerInstance = new Worker(new URL('./image.worker.ts', import.meta.url), {
      type: 'module'
    });
  }
  const worker = workerInstance;
  const id = ++workerReqSeq;

  return new Promise<EncodedCaptureImage>((resolve, reject) => {
    const handleMessage = (event: MessageEvent<ImageWorkerResponse>) => {
      if (event.data.id !== id) return;
      cleanup();
      if (event.data.ok) {
        resolve({
          blob: event.data.blob,
          contentType: event.data.contentType,
          width: event.data.width,
          height: event.data.height,
          byteSize: event.data.blob.size
        });
      } else {
        reject(
          new ImageEncodeError(
            'ENCODE_FAILED',
            `${event.data.error} 원본 보호를 위해 업로드를 차단했습니다.`
          )
        );
      }
    };

    const handleError = () => {
      cleanup();
      reject(
        new ImageEncodeError(
          'ENCODE_FAILED',
          '이미지 전처리 워커 오류가 발생해 원본 업로드를 차단했습니다.'
        )
      );
    };

    const cleanup = () => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.postMessage({ id, ...req } satisfies ImageWorkerRequest);
  });
}

function validateEncodedOutput(
  original: Blob,
  result: EncodedCaptureImage
): EncodedCaptureImage {
  // 절대 원본 객체를 그대로 반환하지 않음 (EXIF 위치 정보 유출 방지)
  if (result.blob === original) {
    throw new ImageEncodeError(
      'ENCODE_FAILED',
      '원본 이미지 파일은 직접 업로드할 수 없습니다. 재인코딩이 필요합니다.'
    );
  }
  if (
    (result.contentType !== 'image/webp' && result.contentType !== 'image/jpeg') ||
    result.blob.type !== result.contentType ||
    result.byteSize <= 0
  ) {
    throw new ImageEncodeError(
      'ENCODE_FAILED',
      '허용된 형식(WebP/JPEG)으로 재인코딩되지 않아 업로드를 차단했습니다.'
    );
  }
  if (result.byteSize > MAX_CAPTURE_FILE_BYTES) {
    throw new ImageEncodeError(
      'FILE_TOO_LARGE',
      '압축된 이미지 크기가 5MB를 초과하여 업로드할 수 없습니다.'
    );
  }
  return result;
}

/**
 * 동시 1장 제한으로 이미지를 축소·재인코딩(WebP 우선 → JPEG 0.82 폴백)하여 EXIF를 제거합니다.
 * 변환/재인코딩 실패 시 원본 업로드를 절대 허용하지 않고 ImageEncodeError를 던집니다.
 */
export async function encodeCaptureImage(
  file: Blob,
  options: ImageEncodeOptions = {}
): Promise<EncodedCaptureImage> {
  const execute = async (): Promise<EncodedCaptureImage> => {
    const maxLongEdge = options.maxLongEdge ?? MAX_IMAGE_LONG_EDGE;
    const webpQuality = options.webpQuality ?? DEFAULT_WEBP_QUALITY;
    const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;

    const probe = options.probeDimensions ?? probeImageDimensionsViaImg;
    const natural = await probe(file);
    const { width, height } = computeTargetDimensions(natural.width, natural.height, maxLongEdge);

    let encoded: EncodedCaptureImage;
    if (options.runWorker) {
      try {
        encoded = await options.runWorker({
          blob: file,
          targetWidth: width,
          targetHeight: height,
          webpQuality,
          jpegQuality
        });
      } catch (workerErr) {
        if (options.encodeMainThread) {
          encoded = await options.encodeMainThread(file, width, height, webpQuality, jpegQuality);
        } else {
          throw workerErr instanceof ImageEncodeError
            ? workerErr
            : new ImageEncodeError(
                'ENCODE_FAILED',
                '이미지 변환에 실패하여 원본 업로드를 차단했습니다. 카메라 설정에서 "높은 호환성(JPEG)"으로 변경해 주세요.'
              );
        }
      }
    } else if (options.encodeMainThread) {
      encoded = await options.encodeMainThread(file, width, height, webpQuality, jpegQuality);
    } else if (canUseImageWorker()) {
      try {
        encoded = await runInSharedWorker({
          blob: file,
          targetWidth: width,
          targetHeight: height,
          webpQuality,
          jpegQuality
        });
      } catch {
        encoded = await encodeOnMainThreadDefault(file, width, height, webpQuality, jpegQuality);
      }
    } else {
      encoded = await encodeOnMainThreadDefault(file, width, height, webpQuality, jpegQuality);
    }

    return validateEncodedOutput(file, encoded);
  };

  // Serialize to strictly 1 image at a time to stay within mobile memory bounds
  const task = sequentialLock.then(execute, execute);
  sequentialLock = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}
