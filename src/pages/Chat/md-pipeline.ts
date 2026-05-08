import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type Renderer from 'markdown-it/lib/renderer.mjs';
import katex from 'katex';
import { trackUiTiming } from '@/lib/telemetry';
import type { AttachedFileMeta } from '@/stores/chat';

const MARKDOWN_RENDER_CACHE_TTL_MS = 10 * 60_000;
const MARKDOWN_RENDER_CACHE_MAX_ENTRIES = 240;
const MARKDOWN_RENDER_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const MARKDOWN_PROCESS_METRIC_MIN_CHARS = 256;
const MARKDOWN_PROCESS_METRIC_MIN_DURATION_MS = 2;
const FILEHINT_HOST = 'matchaclaw.local';
const FILEHINT_PATH_PREFIX = '/__filehint__/';

export interface MarkdownBodyRenderResult {
  fullHtml: string;
}

interface MarkdownBodyRenderCacheEntry {
  value: MarkdownBodyRenderResult;
  bytes: number;
  expiresAt: number;
}

const markdownBodyRenderCache = new Map<string, MarkdownBodyRenderCacheEntry>();
let markdownBodyRenderCacheBytes = 0;

export interface MarkdownRenderCacheStats {
  entryCount: number;
  totalBytes: number;
}

function isWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a;
}

function countPrecedingBackslashes(src: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (src.charCodeAt(cursor) !== 0x5c) {
      break;
    }
    count += 1;
  }
  return count;
}

function isEscaped(src: string, index: number): boolean {
  return countPrecedingBackslashes(src, index) % 2 === 1;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderKatex(content: string, displayMode: boolean): string {
  try {
    return katex.renderToString(content, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      output: 'html',
    });
  } catch {
    return escapeHtml(content);
  }
}

function mathInlineDollarRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src as string;
  if (src.charCodeAt(start) !== 0x24 || src.charCodeAt(start + 1) === 0x24) {
    return false;
  }

  const nextChar = src.charCodeAt(start + 1);
  if (!nextChar || isWhitespaceCode(nextChar)) {
    return false;
  }

  let match = start + 1;
  while ((match = src.indexOf('$', match)) !== -1) {
    if (isEscaped(src, match)) {
      match += 1;
      continue;
    }
    const previousChar = src.charCodeAt(match - 1);
    if (!previousChar || isWhitespaceCode(previousChar)) {
      match += 1;
      continue;
    }
    const content = src.slice(start + 1, match);
    if (!content || content.includes('\n')) {
      return false;
    }
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = content;
      token.markup = '$';
    }
    state.pos = match + 1;
    return true;
  }

  return false;
}

function mathInlineParenRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src as string;
  if (!src.startsWith('\\(', start)) {
    return false;
  }

  let match = start + 2;
  while ((match = src.indexOf('\\)', match)) !== -1) {
    if (isEscaped(src, match)) {
      match += 2;
      continue;
    }
    const content = src.slice(start + 2, match);
    if (!content || content.includes('\n')) {
      return false;
    }
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = content;
      token.markup = '\\(';
    }
    state.pos = match + 2;
    return true;
  }

  return false;
}

function createMathBlockRule(open: string, close: string, markup: string) {
  return (state: any, startLine: number, endLine: number, silent: boolean): boolean => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const firstLine = state.src.slice(start, max);
    if (!firstLine.startsWith(open)) {
      return false;
    }

    const afterOpen = firstLine.slice(open.length);
    const sameLineCloseIndex = afterOpen.indexOf(close);
    if (sameLineCloseIndex >= 0) {
      if (silent) {
        return true;
      }
      const token = state.push('math_block', 'math', 0);
      token.block = true;
      token.content = afterOpen.slice(0, sameLineCloseIndex).trim();
      token.map = [startLine, startLine + 1];
      token.markup = markup;
      state.line = startLine + 1;
      return true;
    }

    const contentLines: string[] = [afterOpen];
    let nextLine = startLine + 1;
    for (; nextLine < endLine; nextLine += 1) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineMax = state.eMarks[nextLine];
      const line = state.src.slice(lineStart, lineMax);
      const closeIndex = line.indexOf(close);
      if (closeIndex >= 0) {
        contentLines.push(line.slice(0, closeIndex));
        if (silent) {
          return true;
        }
        const token = state.push('math_block', 'math', 0);
        token.block = true;
        token.content = contentLines.join('\n').trim();
        token.map = [startLine, nextLine + 1];
        token.markup = markup;
        state.line = nextLine + 1;
        return true;
      }
      contentLines.push(line);
    }

    return false;
  };
}

function createMarkdownRenderer(): MarkdownIt {
  const renderer = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: false,
  });

  const defaultLinkOpenRenderer = renderer.renderer.rules.link_open
    ?? ((tokens: Token[], idx: number, options: any, _env: unknown, self: Renderer) => self.renderToken(tokens, idx, options));

  renderer.renderer.rules.link_open = (
    tokens: Token[],
    idx: number,
    options: any,
    env: unknown,
    self: Renderer,
  ) => {
    const token = tokens[idx];
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpenRenderer(tokens, idx, options, env, self);
  };

  renderer.inline.ruler.after('backticks', 'math_inline_paren', mathInlineParenRule);
  renderer.inline.ruler.after('math_inline_paren', 'math_inline_dollar', mathInlineDollarRule);
  renderer.block.ruler.before('fence', 'math_block_bracket', createMathBlockRule('\\[', '\\]', '\\['), {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  renderer.block.ruler.before('fence', 'math_block_dollar', createMathBlockRule('$$', '$$', '$$'), {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  renderer.renderer.rules.math_inline = (tokens: Token[], idx: number) => renderKatex(tokens[idx]?.content ?? '', false);
  renderer.renderer.rules.math_block = (tokens: Token[], idx: number) => `${renderKatex(tokens[idx]?.content ?? '', true)}\n`;

  return renderer;
}

const markdownRenderer = createMarkdownRenderer();

function nowMonotonicMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function buildAttachedFilesSignature(attachedFiles: AttachedFileMeta[]): string {
  if (attachedFiles.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const file of attachedFiles) {
    parts.push([
      file.fileName,
      file.mimeType,
      file.fileSize,
      file.filePath ?? '',
    ].join(':'));
  }
  return hashStringDjb2(parts.join('|'));
}

export function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export function buildMarkdownCacheKey(input: {
  messageId?: string;
  role?: string;
  timestamp?: number;
  text: string;
  attachedFiles: AttachedFileMeta[];
}): string {
  const roleKey = typeof input.role === 'string' ? input.role : 'assistant';
  const timestampKey = typeof input.timestamp === 'number' ? String(input.timestamp) : 'na';
  const baseKey = typeof input.messageId === 'string' ? input.messageId.trim() : '';
  return [
    baseKey || `${roleKey}:${timestampKey}`,
    hashStringDjb2(input.text),
    buildAttachedFilesSignature(input.attachedFiles),
  ].join('|');
}

function getFileHintHref(encodedHint: string): string {
  return `https://${FILEHINT_HOST}${FILEHINT_PATH_PREFIX}${encodedHint}`;
}

export function decodeFileHintHref(href: string): string | null {
  try {
    const parsed = new URL(href);
    if (parsed.hostname !== FILEHINT_HOST || !parsed.pathname.startsWith(FILEHINT_PATH_PREFIX)) {
      return null;
    }
    return decodeURIComponent(parsed.pathname.slice(FILEHINT_PATH_PREFIX.length));
  } catch {
    return null;
  }
}

function rewriteFileHintHrefs(markdown: string): string {
  return markdown.replace(/\((filehint:([^)\n]+))\)/g, (_full, _href, encodedHint: string) => {
    return `(${getFileHintHref(encodedHint)})`;
  });
}

function pruneMarkdownRenderCache(now = Date.now()): void {
  for (const [key, entry] of markdownBodyRenderCache.entries()) {
    if (entry.expiresAt > now) {
      continue;
    }
    markdownBodyRenderCache.delete(key);
    markdownBodyRenderCacheBytes = Math.max(0, markdownBodyRenderCacheBytes - entry.bytes);
  }
}

function getRenderedMarkdownFromCache(cacheKey: string): MarkdownBodyRenderResult | undefined {
  const now = Date.now();
  const entry = markdownBodyRenderCache.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    markdownBodyRenderCache.delete(cacheKey);
    markdownBodyRenderCacheBytes = Math.max(0, markdownBodyRenderCacheBytes - entry.bytes);
    return undefined;
  }
  markdownBodyRenderCache.delete(cacheKey);
  markdownBodyRenderCache.set(cacheKey, {
    ...entry,
    expiresAt: now + MARKDOWN_RENDER_CACHE_TTL_MS,
  });
  return entry.value;
}

export function peekRenderedMarkdownBody(cacheKey: string): MarkdownBodyRenderResult | undefined {
  return getRenderedMarkdownFromCache(cacheKey);
}

export function getMarkdownRenderCacheStats(): MarkdownRenderCacheStats {
  pruneMarkdownRenderCache(Date.now());
  return {
    entryCount: markdownBodyRenderCache.size,
    totalBytes: markdownBodyRenderCacheBytes,
  };
}

function rememberRenderedMarkdown(cacheKey: string, value: MarkdownBodyRenderResult): void {
  const now = Date.now();
  pruneMarkdownRenderCache(now);
  const bytes = (value.fullHtml.length * 2) + 64;
  const previous = markdownBodyRenderCache.get(cacheKey);
  if (previous) {
    markdownBodyRenderCache.delete(cacheKey);
    markdownBodyRenderCacheBytes = Math.max(0, markdownBodyRenderCacheBytes - previous.bytes);
  }

  markdownBodyRenderCache.set(cacheKey, {
    value,
    bytes,
    expiresAt: now + MARKDOWN_RENDER_CACHE_TTL_MS,
  });
  markdownBodyRenderCacheBytes += bytes;

  while (
    markdownBodyRenderCache.size > MARKDOWN_RENDER_CACHE_MAX_ENTRIES
    || markdownBodyRenderCacheBytes > MARKDOWN_RENDER_CACHE_MAX_BYTES
  ) {
    const oldestKey = markdownBodyRenderCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    const oldest = markdownBodyRenderCache.get(oldestKey);
    markdownBodyRenderCache.delete(oldestKey);
    markdownBodyRenderCacheBytes = Math.max(0, markdownBodyRenderCacheBytes - (oldest?.bytes ?? 0));
  }
}

function renderMarkdownHtml(markdown: string): string {
  return markdownRenderer.render(rewriteFileHintHrefs(markdown));
}

function trackMarkdownProcessCost(markdown: string, durationMs: number): void {
  if (
    markdown.length < MARKDOWN_PROCESS_METRIC_MIN_CHARS
    && durationMs < MARKDOWN_PROCESS_METRIC_MIN_DURATION_MS
  ) {
    return;
  }
  trackUiTiming('chat.md_process_cost', durationMs, {
    cacheState: 'miss',
    chars: markdown.length,
    mode: 'full',
  });
}

export function getOrBuildMarkdownBody(
  cacheKey: string,
  input: { markdown: string },
): MarkdownBodyRenderResult {
  const cached = getRenderedMarkdownFromCache(cacheKey);
  if (cached) {
    return cached;
  }

  const startedAt = nowMonotonicMs();
  const next = {
    fullHtml: renderMarkdownHtml(input.markdown),
  } satisfies MarkdownBodyRenderResult;
  rememberRenderedMarkdown(cacheKey, next);
  trackMarkdownProcessCost(input.markdown, Math.max(0, nowMonotonicMs() - startedAt));
  return next;
}

export function prewarmMarkdownBody(
  cacheKey: string,
  input: { markdown: string },
): MarkdownBodyRenderResult {
  return getOrBuildMarkdownBody(cacheKey, input);
}
