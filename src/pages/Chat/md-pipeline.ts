import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type Renderer from 'markdown-it/lib/renderer.mjs';
import { trackUiTiming } from '@/lib/telemetry';
import type { AttachedFileMeta } from '@/stores/chat';

const MARKDOWN_RENDER_CACHE_TTL_MS = 10 * 60_000;
const MARKDOWN_RENDER_CACHE_MAX_ENTRIES = 240;
const MARKDOWN_RENDER_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const MARKDOWN_PROCESS_METRIC_MIN_CHARS = 256;
const MARKDOWN_PROCESS_METRIC_MIN_DURATION_MS = 2;
const HEAVY_MESSAGE_CHAR_THRESHOLD = 20_000;
const HEAVY_MESSAGE_LINE_THRESHOLD = 260;
const HEAVY_CODE_BLOCK_LINE_THRESHOLD = 24;
const FILEHINT_HOST = 'matchaclaw.local';
const FILEHINT_PATH_PREFIX = '/__filehint__/';

export type MarkdownRenderMode = 'full' | 'lite';
export type MarkdownBodyRenderMode = 'shell' | MarkdownRenderMode;

export interface MarkdownBodyRenderResult {
  shellPreview: MarkdownShellPreview | null;
  liteHtml: string | null;
  fullHtml: string | null;
  canUpgrade: boolean;
}

export interface MarkdownShellPreview {
  text: string;
  truncated: boolean;
  hasLinks: boolean;
  hasCodeBlock: boolean;
}

interface MarkdownBodyRenderCacheEntry {
  value: MarkdownBodyRenderResult;
  bytes: number;
  expiresAt: number;
}

const markdownBodyRenderCache = new Map<string, MarkdownBodyRenderCacheEntry>();
let markdownBodyRenderCacheBytes = 0;

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
});

const defaultLinkOpenRenderer = md.renderer.rules.link_open
  ?? ((tokens: Token[], idx: number, options: any, _env: unknown, self: Renderer) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

function isAllowedExternalHref(rawHref: string): boolean {
  try {
    const parsed = new URL(rawHref, 'https://matchaclaw.local');
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function renderInlineLiteHtml(text: string): string {
  const tokenRe = /(\[[^\]\n]+\]\([^)]+\)|`[^`\n]+`)/g;
  let html = '';
  let cursor = 0;
  let matched: RegExpExecArray | null;

  while ((matched = tokenRe.exec(text)) !== null) {
    if (matched.index > cursor) {
      html += escapeHtml(text.slice(cursor, matched.index));
    }
    const token = matched[0];
    if (token.startsWith('`')) {
      html += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
      cursor = matched.index + token.length;
      continue;
    }
    const linkMatch = token.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)$/);
    if (!linkMatch) {
      html += escapeHtml(token);
      cursor = matched.index + token.length;
      continue;
    }
    const [, label, href] = linkMatch;
    if (isAllowedExternalHref(href)) {
      html += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    } else {
      html += escapeHtml(label);
    }
    cursor = matched.index + token.length;
  }

  if (cursor < text.length) {
    html += escapeHtml(text.slice(cursor));
  }

  return html;
}

function splitLiteBlocks(markdown: string): Array<
  | { kind: 'paragraph'; content: string }
  | { kind: 'code'; language: string; content: string }
> {
  const blocks: Array<
    | { kind: 'paragraph'; content: string }
    | { kind: 'code'; language: string; content: string }
  > = [];
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let matched: RegExpExecArray | null;
  while ((matched = fenceRe.exec(markdown)) !== null) {
    const [fullMatch, language = '', codeContent = ''] = matched;
    if (matched.index > cursor) {
      pushLiteParagraphBlocks(blocks, markdown.slice(cursor, matched.index));
    }
    blocks.push({
      kind: 'code',
      language: language.trim(),
      content: codeContent.replace(/\s+$/, ''),
    });
    cursor = matched.index + fullMatch.length;
  }
  if (cursor < markdown.length) {
    pushLiteParagraphBlocks(blocks, markdown.slice(cursor));
  }
  return blocks;
}

function pushLiteParagraphBlocks(
  target: Array<
    | { kind: 'paragraph'; content: string }
    | { kind: 'code'; language: string; content: string }
  >,
  source: string,
): void {
  const paragraphs = source
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  for (const paragraph of paragraphs) {
    target.push({
      kind: 'paragraph',
      content: paragraph,
    });
  }
}

function renderLiteCodeBlockHtml(language: string, content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.length <= HEAVY_CODE_BLOCK_LINE_THRESHOLD) {
    return `<div class="chat-md-lite-code"><div class="chat-md-lite-code__header">${escapeHtml(language || 'code')}</div><pre><code>${escapeHtml(content)}</code></pre></div>`;
  }
  const preview = lines.slice(0, HEAVY_CODE_BLOCK_LINE_THRESHOLD).join('\n');
  return [
    '<details class="chat-md-lite-code" open>',
    `<summary class="chat-md-lite-code__summary"><span>${escapeHtml(language || 'code')}</span><span>Show full code</span></summary>`,
    `<pre><code>${escapeHtml(preview)}</code></pre>`,
    `<div class="chat-md-lite-code__full"><pre><code>${escapeHtml(content)}</code></pre></div>`,
    '</details>',
  ].join('');
}

function renderLiteMarkdownHtml(markdown: string): string {
  const blocks = splitLiteBlocks(markdown);
  return blocks.map((block) => {
    if (block.kind === 'code') {
      return renderLiteCodeBlockHtml(block.language, block.content);
    }
    return `<p>${renderInlineLiteHtml(block.content).replace(/\n/g, '<br />')}</p>`;
  }).join('');
}

function stripMarkdownForShellPreview(markdown: string): MarkdownShellPreview {
  const hasCodeBlock = /```/.test(markdown);
  const hasLinks = /\[[^\]\n]+\]\([^)]+\)/.test(markdown) || /\bhttps?:\/\/\S+/i.test(markdown);
  const normalized = markdown
    .replace(/```([^\n`]*)\n[\s\S]*?```/g, (_match, language = '') => `[${String(language).trim() || 'code'} block]`)
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\r/g, '')
    .trim();
  const previewLines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);
  const previewText = previewLines.join('\n');
  const truncated = normalized.length > previewText.length;
  return {
    text: previewText || normalized.slice(0, 280),
    truncated,
    hasLinks,
    hasCodeBlock,
  };
}

export function shouldUseLiteMarkdown(markdown: string, isStreaming: boolean): boolean {
  if (isStreaming) {
    return false;
  }
  if (markdown.length >= HEAVY_MESSAGE_CHAR_THRESHOLD) {
    return true;
  }
  return markdown.split(/\r?\n/).length >= HEAVY_MESSAGE_LINE_THRESHOLD;
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

function rememberRenderedMarkdown(cacheKey: string, value: MarkdownBodyRenderResult): void {
  const now = Date.now();
  pruneMarkdownRenderCache(now);
  const previewBytes = value.shellPreview
    ? (value.shellPreview.text.length * 2) + 32
    : 0;
  const liteBytes = value.liteHtml ? (value.liteHtml.length * 2) : 0;
  const fullBytes = value.fullHtml ? (value.fullHtml.length * 2) : 0;
  const bytes = previewBytes + liteBytes + fullBytes + 64;
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

function renderFullMarkdownHtml(markdown: string): string {
  return md.render(rewriteFileHintHrefs(markdown));
}

function trackMarkdownProcessCost(markdown: string, durationMs: number, mode: MarkdownRenderMode): void {
  if (
    markdown.length < MARKDOWN_PROCESS_METRIC_MIN_CHARS
    && durationMs < MARKDOWN_PROCESS_METRIC_MIN_DURATION_MS
  ) {
    return;
  }
  trackUiTiming('chat.md_process_cost', durationMs, {
    cacheState: 'miss',
    chars: markdown.length,
    mode,
  });
}

export function getOrBuildMarkdownBody(
  cacheKey: string,
  input: {
    markdown: string;
    allowLite: boolean;
    mode: MarkdownBodyRenderMode;
  },
): MarkdownBodyRenderResult {
  const cacheIdentity = `${cacheKey}|${input.allowLite ? 'defer' : 'eager'}`;
  const cached = getRenderedMarkdownFromCache(cacheIdentity);
  const base = cached ?? {
    shellPreview: input.allowLite ? stripMarkdownForShellPreview(input.markdown) : null,
    liteHtml: null,
    fullHtml: null,
    canUpgrade: input.allowLite,
  } satisfies MarkdownBodyRenderResult;

  if (input.mode === 'shell') {
    if (cached === undefined) {
      rememberRenderedMarkdown(cacheIdentity, base);
    }
    return base;
  }

  if (input.mode === 'lite' && base.liteHtml == null) {
    const startedAt = nowMonotonicMs();
    const next = {
      ...base,
      liteHtml: renderLiteMarkdownHtml(input.markdown),
    } satisfies MarkdownBodyRenderResult;
    rememberRenderedMarkdown(cacheIdentity, next);
    trackMarkdownProcessCost(input.markdown, Math.max(0, nowMonotonicMs() - startedAt), 'lite');
    return next;
  }

  if (input.mode === 'full' && base.fullHtml == null) {
    const startedAt = nowMonotonicMs();
    const next = {
      ...base,
      fullHtml: renderFullMarkdownHtml(input.markdown),
    } satisfies MarkdownBodyRenderResult;
    rememberRenderedMarkdown(cacheIdentity, next);
    trackMarkdownProcessCost(input.markdown, Math.max(0, nowMonotonicMs() - startedAt), 'full');
    return next;
  }

  return base;
}
