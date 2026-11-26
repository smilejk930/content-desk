import exifr from 'exifr';

export interface CaptureExifMeta {
  takenAt: string | null;
  orientation: number | null;
}

export interface RawExifSample {
  DateTimeOriginal?: unknown;
  OffsetTimeOriginal?: unknown;
  Orientation?: unknown;
}

export type ExifParserFn = (
  input: Blob | ArrayBuffer | Uint8Array,
  options: {
    pick: string[];
    gps: false;
    reviveValues: false;
  }
) => Promise<RawExifSample | undefined>;

const DEFAULT_KST_OFFSET = '+09:00';
const OFFSET_RE = /^(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const EXIF_DATETIME_RE = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

function normalizeOffset(rawOffset: unknown): string {
  if (typeof rawOffset !== 'string') return DEFAULT_KST_OFFSET;
  const trimmed = rawOffset.trim();
  if (OFFSET_RE.test(trimmed)) return trimmed;
  return DEFAULT_KST_OFFSET;
}

function formatTakenAtIso(rawDate: unknown, rawOffset: unknown): string | null {
  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    return rawDate.toISOString();
  }
  if (typeof rawDate !== 'string') return null;

  const trimmed = rawDate.trim();
  if (!trimmed) return null;

  const match = trimmed.match(EXIF_DATETIME_RE);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    const offset = normalizeOffset(rawOffset);
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) {
      return iso;
    }
    return null;
  }

  // Fallback if already ISO-like with offset/Z
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed)) {
      return trimmed;
    }
    return parsed.toISOString();
  }

  return null;
}

function normalizeOrientation(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 8) {
    return raw;
  }
  return null;
}

/**
 * EXIF 어댑터 (`exifr` 래핑).
 * gps: false 옵션을 강제하여 위치 정보(위도/경도 등)는 절대 추출하지 않고,
 * 촬영 일시(OffsetTimeOriginal 미존재 시 KST +09:00 폴백)와 방향만 읽습니다.
 */
export async function readCaptureMeta(
  file: Blob | ArrayBuffer | Uint8Array,
  parseFn: ExifParserFn = (input, opts) => exifr.parse(input, opts) as Promise<RawExifSample | undefined>
): Promise<CaptureExifMeta> {
  try {
    const raw = await parseFn(file, {
      pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'Orientation'],
      gps: false,
      reviveValues: false
    });

    if (!raw || typeof raw !== 'object') {
      return { takenAt: null, orientation: null };
    }

    return {
      takenAt: formatTakenAtIso(raw.DateTimeOriginal, raw.OffsetTimeOriginal),
      orientation: normalizeOrientation(raw.Orientation)
    };
  } catch {
    return { takenAt: null, orientation: null };
  }
}
