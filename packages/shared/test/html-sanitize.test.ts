import { describe, expect, it } from 'vitest';
import { sanitizeManuscriptHtml } from '../src/index.js';

describe('sanitizeManuscriptHtml', () => {
  it('keeps allowed formatting tags and strips all attributes', () => {
    const input = '<h2 class="x" style="color:red">소제목</h2><p onclick="alert(1)"><strong>강조</strong> 본문<br/>줄바꿈</p>';
    expect(sanitizeManuscriptHtml(input)).toBe('<h2>소제목</h2><p><strong>강조</strong> 본문<br>줄바꿈</p>');
  });

  it('blocks XSS scripts, iframes, and javascript: links', () => {
    const input = '<p>안전</p><script>alert(1)</script><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">클릭</a>';
    expect(sanitizeManuscriptHtml(input, ['https://docs.example.com/guide'])).toBe('<p>안전</p>클릭');
  });

  it('retains href ONLY for allowlisted http/https source URLs', () => {
    const allowed = ['https://docs.example.com/spec'];
    const input =
      '<p><a href="https://docs.example.com/spec" target="_blank">공식 문서</a> / ' +
      '<a href="https://unlisted.example.com/phish">비허용 링크</a></p>';
    expect(sanitizeManuscriptHtml(input, allowed)).toBe(
      '<p><a href="https://docs.example.com/spec">공식 문서</a> / 비허용 링크</p>'
    );
  });
});
