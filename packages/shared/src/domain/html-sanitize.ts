const ALLOWED_TAGS = new Set([
  'p', 'h2', 'h3', 'strong', 'ul', 'ol', 'li', 'blockquote', 'a', 'br'
]);

const VOID_TAGS = new Set(['br']);
const STRIP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math']);

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeHttpUrl(raw: string): string | null {
  try {
    const parsed = new URL(decodeBasicEntities(raw).trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractHref(attrChunk: string): string | null {
  const match = attrChunk.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

interface StackFrame {
  tag: string;
  emit: boolean;
}

/**
 * Allows only p, h2, h3, strong, ul, ol, li, blockquote, a, br.
 * Strips all attributes except href on <a>, and keeps href ONLY when it is an
 * http/https URL explicitly present in allowedSourceUrls.
 */
export function sanitizeManuscriptHtml(
  html: string,
  allowedSourceUrls: readonly string[] = []
): string {
  const allowedNormalized = new Set<string>();
  for (const url of allowedSourceUrls) {
    const normalized = normalizeHttpUrl(url);
    if (normalized) allowedNormalized.add(normalized);
  }

  let cleaned = html;
  for (const tag of STRIP_CONTENT_TAGS) {
    const blockRe = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi');
    cleaned = cleaned.replace(blockRe, '');
    const openOnlyRe = new RegExp('<' + tag + '\\b[^>]*>', 'gi');
    cleaned = cleaned.replace(openOnlyRe, '');
  }

  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  const output: string[] = [];
  const stack: StackFrame[] = [];
  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)/g;

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(cleaned)) !== null) {
    const [, slash, rawTag, rawAttrs, textNode] = match;
    if (textNode !== undefined) {
      output.push(textNode);
      continue;
    }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) continue;

    if (slash === '/') {
      if (VOID_TAGS.has(tag)) continue;
      let stackIdx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.tag === tag) {
          stackIdx = i;
          break;
        }
      }
      if (stackIdx >= 0) {
        while (stack.length > stackIdx) {
          const popped = stack.pop()!;
          if (popped.emit) output.push(`</${popped.tag}>`);
        }
      }
      continue;
    }

    if (VOID_TAGS.has(tag)) {
      output.push('<br>');
      continue;
    }

    if (tag === 'a') {
      const rawHref = extractHref(rawAttrs ?? '');
      const normalizedHref = rawHref ? normalizeHttpUrl(rawHref) : null;
      if (normalizedHref && allowedNormalized.has(normalizedHref)) {
        output.push(`<a href="${escapeHtmlAttr(normalizedHref)}">`);
        stack.push({ tag: 'a', emit: true });
      } else {
        stack.push({ tag: 'a', emit: false });
      }
      continue;
    }

    output.push(`<${tag}>`);
    stack.push({ tag, emit: true });
  }

  while (stack.length > 0) {
    const popped = stack.pop()!;
    if (popped.emit) output.push(`</${popped.tag}>`);
  }

  return output.join('');
}
