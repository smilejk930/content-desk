import {
  formatImageMarker,
  isManuscriptApprovedForExport,
  sanitizeManuscriptHtml,
  stripHtmlToPlainText,
  type NaverBlogManuscriptBundle
} from '@content-desk/shared';

export interface CopyGateInput {
  manuscript: Pick<NaverBlogManuscriptBundle, 'content_hash' | 'approved_hash'>;
  unresolvedVerifyCount: number;
}

export interface RichCopyPayloadInput {
  bodyHtml: string;
  allowedSourceUrls: readonly string[];
  ftcDisclosure?: string | null;
  aiDisclosure?: string | null;
  images?: ReadonlyArray<{ seq: number; caption: string }>;
}

export interface RichCopyPayload {
  html: string;
  plainText: string;
  formattingGuide: Array<{ kind: '소제목' | '강조'; text: string }>;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function assertVerifiedCopyGate(gate: CopyGateInput): void {
  if (!isManuscriptApprovedForExport(gate.manuscript, gate.unresolvedVerifyCount)) {
    throw new Error(
      '검증 완료 및 최신 버전 승인(approved_hash === content_hash, 미해소 [VERIFY] 0건)된 원고만 복사·내보내기할 수 있습니다.'
    );
  }
}

export function isRichClipboardSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof navigator.clipboard.write === 'function' &&
    typeof ClipboardItem !== 'undefined'
  );
}

/**
 * 일반 텍스트 복사 시 수동 서식 적용을 돕는 소제목/굵게 안내 추출.
 */
export function extractFormattingGuide(
  sanitizedHtml: string
): Array<{ kind: '소제목' | '강조'; text: string }> {
  const items: Array<{ kind: '소제목' | '강조'; text: string }> = [];
  const headingRe = /<h[23]>([\s\S]*?)<\/h[23]>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(sanitizedHtml)) !== null) {
    const text = stripHtmlToPlainText(match[1] ?? '').trim();
    if (text) items.push({ kind: '소제목', text });
  }
  const strongRe = /<strong>([\s\S]*?)<\/strong>/gi;
  while ((match = strongRe.exec(sanitizedHtml)) !== null) {
    const text = stripHtmlToPlainText(match[1] ?? '').trim();
    if (text && !items.some((i) => i.text === text)) {
      items.push({ kind: '강조', text });
    }
  }
  return items.slice(0, 12);
}

function normalizeForInclusionCheck(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 네이버 스마트에디터 ONE 붙여넣기용 정제 HTML + 일반 텍스트 페이로드 생성:
 * - 공용 sanitizeManuscriptHtml 적용
 * - 상단 공정위(협찬) 공시 문구 및 하단 AI 도식 활용 공시 문구 포함
 * - 본문에 누락된 [📷 이미지 N 삽입 위치: 캡션] 마커 보강
 * - 포함 여부는 이스케이프된 HTML이 아닌 평문(stripHtmlToPlainText) 공백 정규화 기준으로 비교해
 *   &, ", '가 포함된 협찬사명·캡션의 중복 삽입을 방지합니다.
 */
export function buildNaverCopyPayload(input: RichCopyPayloadInput): RichCopyPayload {
  let workingHtml = sanitizeManuscriptHtml(input.bodyHtml, input.allowedSourceUrls);
  const plainNormalized = normalizeForInclusionCheck(stripHtmlToPlainText(workingHtml));

  const ftc = input.ftcDisclosure?.trim() ?? '';
  if (ftc && !plainNormalized.includes(normalizeForInclusionCheck(ftc))) {
    workingHtml = `<p><strong>${escapeHtmlText(ftc)}</strong></p>${workingHtml}`;
  }

  for (const img of [...(input.images ?? [])].sort((a, b) => a.seq - b.seq)) {
    const marker = formatImageMarker(img.seq, img.caption);
    if (!plainNormalized.includes(normalizeForInclusionCheck(marker))) {
      workingHtml = `${workingHtml}<p>${escapeHtmlText(marker)}</p>`;
    }
  }

  const ai = input.aiDisclosure?.trim() ?? '';
  if (ai && !plainNormalized.includes(normalizeForInclusionCheck(ai))) {
    workingHtml = `${workingHtml}<p>${escapeHtmlText(ai)}</p>`;
  }

  const finalHtml = sanitizeManuscriptHtml(workingHtml, input.allowedSourceUrls);
  const plainText = stripHtmlToPlainText(finalHtml);
  const formattingGuide = extractFormattingGuide(finalHtml);

  return {
    html: finalHtml,
    plainText,
    formattingGuide
  };
}

/**
 * 클릭 핸들러 안에서 동기적으로 ClipboardItem({ 'text/html': Promise<Blob>, 'text/plain': Promise<Blob> })를
 * 호출하여 iOS Safari / Android Chrome 사용자 제스처 만료를 방지합니다.
 * - ClipboardItem 미지원 또는 쓰기 실패 시 text/plain 폴백을 수행합니다.
 */
export function copyRichManuscriptToClipboard(
  input: RichCopyPayloadInput,
  gate: CopyGateInput
): Promise<{ mode: 'rich' | 'plain'; payload: RichCopyPayload }> {
  assertVerifiedCopyGate(gate);

  const payload = buildNaverCopyPayload(input);

  if (isRichClipboardSupported()) {
    const htmlPromise = Promise.resolve(new Blob([payload.html], { type: 'text/html' }));
    const textPromise = Promise.resolve(new Blob([payload.plainText], { type: 'text/plain' }));
    const item = new ClipboardItem({
      'text/html': htmlPromise,
      'text/plain': textPromise
    });

    // 동기적으로 clipboard.write 호출 (사전 await 금지)
    return navigator.clipboard
      .write([item])
      .then(() => ({ mode: 'rich' as const, payload }))
      .catch(async () => {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(payload.plainText);
          return { mode: 'plain' as const, payload };
        }
        throw new Error('클립보드 복사를 지원하지 않는 브라우저입니다.');
      });
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard
      .writeText(payload.plainText)
      .then(() => ({ mode: 'plain' as const, payload }));
  }

  return Promise.reject(new Error('클립보드 복사를 지원하지 않는 브라우저입니다.'));
}

export function copyPlainTextToClipboard(
  text: string,
  gate?: CopyGateInput
): Promise<void> {
  if (gate) {
    assertVerifiedCopyGate(gate);
  }
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return Promise.reject(new Error('클립보드 텍스트 복사를 지원하지 않는 브라우저입니다.'));
  }
  return navigator.clipboard.writeText(text);
}
