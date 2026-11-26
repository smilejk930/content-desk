import { useMemo } from 'react';
import { sanitizeManuscriptHtml } from '@content-desk/shared';

export interface IsolatedPreviewProps {
  title: string;
  bodyHtml: string;
  allowedSourceUrls: readonly string[];
  ftcDisclosure?: string | null;
  aiDisclosure?: string | null;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 대시보드 CSS 및 스크립트 실행 환경과 완전히 격리된 원고 미리보기.
 * - 클라이언트 측 sanitizeManuscriptHtml 2중 정제 적용
 * - <iframe sandbox="" srcDoc={...}>로 스크립트·폼·동일 출처 접근·스타일 오염을 원천 차단
 */
export function IsolatedPreview({
  title,
  bodyHtml,
  allowedSourceUrls,
  ftcDisclosure,
  aiDisclosure
}: IsolatedPreviewProps) {
  const srcDoc = useMemo(() => {
    const cleanBody = sanitizeManuscriptHtml(bodyHtml, allowedSourceUrls);
    const safeTitle = escapeHtmlText(title);
    const safeFtc = ftcDisclosure ? `<div class="disclosure ftc">${escapeHtmlText(ftcDisclosure)}</div>` : '';
    const safeAi = aiDisclosure ? `<div class="disclosure ai">${escapeHtmlText(aiDisclosure)}</div>` : '';

    return [
      '<!doctype html>',
      '<html lang="ko">',
      '<head>',
      '<meta charset="utf-8" />',
      '<style>',
      'body{margin:0;padding:20px;background:#ffffff;color:#222222;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:15px;line-height:1.75;word-break:keep-all;overflow-wrap:anywhere;}',
      'h1{font-size:22px;font-weight:700;margin:0 0 16px;padding-bottom:12px;border-bottom:1px solid #e5e5e5;color:#111111;}',
      'h2{font-size:18px;font-weight:700;margin:24px 0 10px;color:#111111;}',
      'h3{font-size:16px;font-weight:600;margin:18px 0 8px;color:#222222;}',
      'p{margin:0 0 12px;}',
      'ul,ol{margin:0 0 14px;padding-left:22px;}',
      'li{margin:4px 0;}',
      'blockquote{margin:14px 0;padding:10px 14px;border-left:3px solid #00754a;background:#f7f7f7;color:#444444;}',
      'a{color:#006241;text-decoration:underline;}',
      '.disclosure{margin:0 0 12px;padding:10px 12px;border-radius:8px;font-size:13px;}',
      '.disclosure.ftc{background:#faf6ee;border:1px solid #cba258;color:#333333;}',
      '.disclosure.ai{background:#f2f0eb;border:1px solid #cccccc;color:#333333;}',
      '</style>',
      '</head>',
      '<body>',
      `<h1>${safeTitle}</h1>`,
      safeFtc,
      safeAi,
      `<article>${cleanBody}</article>`,
      '</body>',
      '</html>'
    ].join('');
  }, [title, bodyHtml, allowedSourceUrls, ftcDisclosure, aiDisclosure]);

  return (
    <div className="overflow-hidden rounded-xl border border-ink/15 bg-surface">
      <div className="flex items-center justify-between border-b border-ink/10 bg-surface-subtle px-4 py-2 text-xs text-ink-soft">
        <span>격리 미리보기 (iframe sandbox=&quot;&quot;)</span>
        <span>스크립트 실행·외부 스타일 차단됨</span>
      </div>
      <iframe
        title="원고 격리 미리보기"
        sandbox=""
        srcDoc={srcDoc}
        className="h-[360px] w-full border-0 bg-surface"
      />
    </div>
  );
}
