import { describe, expect, it, vi } from 'vitest';
import { readCaptureMeta, type ExifParserFn } from '../src/platform/exif';

describe('readCaptureMeta (EXIF 어댑터)', () => {
  it('always passes gps: false and reviveValues: false, and combines OffsetTimeOriginal', async () => {
    const mockParse = vi.fn<ExifParserFn>(async () => ({
      DateTimeOriginal: '2026:11:20 14:30:05',
      OffsetTimeOriginal: '-05:00',
      Orientation: 6
    }));

    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    const meta = await readCaptureMeta(blob, mockParse);

    expect(mockParse).toHaveBeenCalledWith(blob, {
      pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'Orientation'],
      gps: false,
      reviveValues: false
    });
    expect(meta).toEqual({
      takenAt: '2026-11-20T14:30:05-05:00',
      orientation: 6
    });
    expect(Object.keys(meta)).toEqual(['takenAt', 'orientation']);
  });

  it('falls back to KST (+09:00) when OffsetTimeOriginal is missing or invalid', async () => {
    const mockParse = vi.fn<ExifParserFn>(async () => ({
      DateTimeOriginal: '2026:11:26 09:15:00',
      Orientation: 1
    }));

    const meta = await readCaptureMeta(new Uint8Array([1, 2, 3]), mockParse);
    expect(meta).toEqual({
      takenAt: '2026-11-26T09:15:00+09:00',
      orientation: 1
    });
  });

  it('returns nulls safely when EXIF is absent or parser throws', async () => {
    const emptyMeta = await readCaptureMeta(new Uint8Array([0]), async () => undefined);
    expect(emptyMeta).toEqual({ takenAt: null, orientation: null });

    const errorMeta = await readCaptureMeta(new Uint8Array([0]), async () => {
      throw new Error('corrupted exif');
    });
    expect(errorMeta).toEqual({ takenAt: null, orientation: null });
  });
});
