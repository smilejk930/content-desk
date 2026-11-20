export interface SponsorshipInfo {
  is_sponsored: boolean;
  provider_name?: string;
  compensation_type?: string;
}

export interface ManuscriptSegment {
  type: 'text' | 'image_marker';
  content: string;
  imageIndex?: number;
  caption?: string;
}

const IMAGE_MARKER_RE = /\[📷\s*이미지\s*(\d+)\s*삽입\s*위치\s*:\s*([^\]]+)\]/g;

export function formatImageMarker(index: number, caption: string): string {
  const safeCaption = caption.trim() || `이미지 ${index}`;
  return `[📷 이미지 ${index} 삽입 위치: ${safeCaption}]`;
}

export function splitManuscriptByImageMarkers(body: string): ManuscriptSegment[] {
  const segments: ManuscriptSegment[] = [];
  let lastIndex = 0;
  IMAGE_MARKER_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = IMAGE_MARKER_RE.exec(body)) !== null) {
    if (match.index > lastIndex) {
      const textChunk = body.slice(lastIndex, match.index);
      if (textChunk.length > 0) {
        segments.push({ type: 'text', content: textChunk });
      }
    }
    const imageIndex = Number.parseInt(match[1] ?? '0', 10);
    const caption = (match[2] ?? '').trim();
    segments.push({
      type: 'image_marker',
      content: match[0],
      imageIndex,
      caption
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < body.length) {
    segments.push({ type: 'text', content: body.slice(lastIndex) });
  }

  return segments;
}

export function buildSequentialImageFilename(seq: number, caption: string, ext = 'jpg'): string {
  const prefix = String(Math.max(1, Math.floor(seq))).padStart(2, '0');
  const safeCaption = caption
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 40) || 'image';
  const safeExt = ext.replace(/^\./, '').toLowerCase() || 'jpg';
  return `${prefix}_${safeCaption}.${safeExt}`;
}

export function buildFtcDisclosure(sponsorship: SponsorshipInfo): string | null {
  if (!sponsorship.is_sponsored) return null;
  const provider = sponsorship.provider_name?.trim() || '업체';
  const comp = sponsorship.compensation_type?.trim() || '경제적 대가(제품·서비스 또는 원고료)';
  return `본 포스팅은 ${provider}로부터 ${comp}를 제공받아 작성하였습니다.`;
}

export function buildAiImageDisclosure(hasAiImages: boolean): string | null {
  if (!hasAiImages) return null;
  return '본문 내 일부 개념 도식 이미지는 이해를 돕기 위해 AI로 생성되었습니다.';
}
