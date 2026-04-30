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
