import { describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURE_FILE_BYTES } from '@content-desk/shared';
import {
  computeTargetDimensions,
  encodeCaptureImage,
  ImageEncodeError
} from '../src/platform/image-encode';

describe('image-encode (24MP 안전 축소 · EXIF 제거 · 실패 시 원본 차단)', () => {
  it('scales landscape and portrait 24MP dimensions down to max 2560px long edge', () => {
    expect(computeTargetDimensions(6000, 4000)).toEqual({ width: 2560, height: 1707 });
    expect(computeTargetDimensions(4000, 6000)).toEqual({ width: 1707, height: 2560 });
    expect(computeTargetDimensions(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(() => computeTargetDimensions(0, 100)).toThrow(ImageEncodeError);
  });

  it('encodes to WebP when supported and passes computed target size to worker', async () => {
    const original = new Blob([new Uint8Array(100)], { type: 'image/jpeg' });
    const encodedBlob = new Blob([new Uint8Array(50)], { type: 'image/webp' });
    const runWorker = vi.fn(async (req) => ({
      blob: encodedBlob,
      contentType: 'image/webp' as const,
      width: req.targetWidth,
      height: req.targetHeight,
      byteSize: encodedBlob.size
    }));

    const result = await encodeCaptureImage(original, {
      probeDimensions: async () => ({ width: 6000, height: 4000 }),
      runWorker
    });

    expect(runWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        targetWidth: 2560,
        targetHeight: 1707,
        webpQuality: 0.82,
        jpegQuality: 0.82
      })
    );
    expect(result.contentType).toBe('image/webp');
    expect(result.blob).not.toBe(original);
    expect(result.width).toBe(2560);
    expect(result.height).toBe(1707);
  });

  it('falls back to JPEG when WebP worker encoding fails and main-thread fallback succeeds', async () => {
    const original = new Blob([new Uint8Array(100)], { type: 'image/heic' });
    const jpegBlob = new Blob([new Uint8Array(64)], { type: 'image/jpeg' });

    const result = await encodeCaptureImage(original, {
      probeDimensions: async () => ({ width: 3000, height: 2000 }),
      runWorker: async () => {
        throw new Error('OffscreenCanvas WebP unavailable');
      },
      encodeMainThread: async (_blob, width, height) => ({
        blob: jpegBlob,
        contentType: 'image/jpeg',
        width,
        height,
        byteSize: jpegBlob.size
      })
    });

    expect(result.contentType).toBe('image/jpeg');
    expect(result.width).toBe(2560);
    expect(result.height).toBe(1707);
  });

  it('blocks upload with explicit ImageEncodeError (never returning original) when decode or re-encode fails', async () => {
    const original = new Blob([new Uint8Array(100)], { type: 'image/heif' });

    // Decode failure
    await expect(
      encodeCaptureImage(original, {
        probeDimensions: async () => {
          throw new ImageEncodeError('DECODE_FAILED', 'HEIF 디코딩 실패 - 높은 호환성(JPEG) 설정 필요');
        }
      })
    ).rejects.toThrow(ImageEncodeError);

    // Worker returns original blob directly -> MUST be rejected to prevent EXIF GPS leak
    await expect(
      encodeCaptureImage(original, {
        probeDimensions: async () => ({ width: 1200, height: 800 }),
        runWorker: async () => ({
          blob: original,
          contentType: 'image/jpeg',
          width: 1200,
          height: 800,
          byteSize: original.size
        })
      })
    ).rejects.toThrow(ImageEncodeError);

    // Oversized output (> 5MB) -> MUST be rejected
    const oversized = new Blob([new Uint8Array(MAX_CAPTURE_FILE_BYTES + 1)], {
      type: 'image/jpeg'
    });
    await expect(
      encodeCaptureImage(original, {
        probeDimensions: async () => ({ width: 2000, height: 2000 }),
        runWorker: async () => ({
          blob: oversized,
          contentType: 'image/jpeg',
          width: 2000,
          height: 2000,
          byteSize: oversized.size
        })
      })
    ).rejects.toThrow(ImageEncodeError);
  });

  it('processes concurrent calls strictly one image at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const makeCall = (idx: number) =>
      encodeCaptureImage(new Blob([new Uint8Array([idx])], { type: 'image/jpeg' }), {
        probeDimensions: async () => ({ width: 1000, height: 1000 }),
        runWorker: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight -= 1;
          const out = new Blob([new Uint8Array([idx, 1])], { type: 'image/webp' });
          return {
            blob: out,
            contentType: 'image/webp',
            width: 1000,
            height: 1000,
            byteSize: out.size
          };
        }
      });

    await Promise.all([makeCall(1), makeCall(2), makeCall(3)]);
    expect(maxInFlight).toBe(1);
  });
});
