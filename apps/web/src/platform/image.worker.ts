/// <reference lib="webworker" />

export interface ImageWorkerRequest {
  id: number;
  blob: Blob;
  targetWidth: number;
  targetHeight: number;
  webpQuality: number;
  jpegQuality: number;
}

export interface ImageWorkerSuccess {
  id: number;
  ok: true;
  blob: Blob;
  contentType: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
}

export interface ImageWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

export type ImageWorkerResponse = ImageWorkerSuccess | ImageWorkerFailure;

async function encodeInWorker(req: ImageWorkerRequest): Promise<ImageWorkerSuccess> {
  let bitmap: ImageBitmap | null = null;
  const canvas = new OffscreenCanvas(req.targetWidth, req.targetHeight);

  try {
    try {
      const resized = await createImageBitmap(req.blob, {
        imageOrientation: 'from-image',
        resizeWidth: req.targetWidth,
        resizeHeight: req.targetHeight,
        resizeQuality: 'high'
      });

      if (
        Math.abs(resized.width - req.targetWidth) <= 1 &&
        Math.abs(resized.height - req.targetHeight) <= 1
      ) {
        bitmap = resized;
      } else {
        resized.close();
      }
    } catch {
      bitmap = null;
    }

    if (!bitmap) {
      bitmap = await createImageBitmap(req.blob, {
        imageOrientation: 'from-image'
      });
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D 캔버스 컨텍스트를 생성할 수 없습니다.');
    }

    ctx.drawImage(bitmap, 0, 0, req.targetWidth, req.targetHeight);

    let encoded: Blob | null = null;
    try {
      const webpBlob = await canvas.convertToBlob({
        type: 'image/webp',
        quality: req.webpQuality
      });
      if (webpBlob.type === 'image/webp' && webpBlob.size > 0) {
        encoded = webpBlob;
      }
    } catch {
      encoded = null;
    }

    if (!encoded) {
      const jpegBlob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: req.jpegQuality
      });
      if (jpegBlob.type === 'image/jpeg' && jpegBlob.size > 0) {
        encoded = jpegBlob;
      }
    }

    if (!encoded || (encoded.type !== 'image/webp' && encoded.type !== 'image/jpeg')) {
      throw new Error('WebP 및 JPEG 재인코딩에 모두 실패했습니다.');
    }

    return {
      id: req.id,
      ok: true,
      blob: encoded,
      contentType: encoded.type,
      width: req.targetWidth,
      height: req.targetHeight
    };
  } finally {
    if (bitmap) {
      bitmap.close();
    }
    canvas.width = 0;
    canvas.height = 0;
  }
}

self.onmessage = async (event: MessageEvent<ImageWorkerRequest>) => {
  const req = event.data;
  try {
    const result = await encodeInWorker(req);
    self.postMessage(result satisfies ImageWorkerResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : '이미지 변환 중 오류가 발생했습니다.';
    self.postMessage({
      id: req.id,
      ok: false,
      error: message
    } satisfies ImageWorkerResponse);
  }
};
