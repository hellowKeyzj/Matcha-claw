import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type Renderer from 'markdown-it/lib/renderer.mjs';
import { trackUiTiming } from '@/lib/telemetry';
import type { AttachedFileMeta } from '@/plugins/message-rendering/attachments';
import type { MarkdownExtension } from './extensions';
import { BUILTIN_MARKDOWN_EXTENSIONS } from './md-rules';

const MARKDOWN_RENDER_CACHE_TTL_MS = 10 * 60_000;
const MARKDOWN_RENDER_CACHE_MAX_ENTRIES = 240;
const MARKDOWN_RENDER_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const MARKDOWN_PROCESS_METRIC_MIN_CHARS = 256;
const MARKDOWN_PROCESS_METRIC_MIN_DURATION_MS = 2;
const FILEHINT_HOST = 'matchaclaw.local';
const FILEHINT_PATH_PREFIX = '/__filehint__/';

type MarkdownRenderOptions = Parameters<Renderer['renderToken']>[2];
export interface MarkdownBodyRenderResult {
  fullHtml: string;
}

interface MarkdownBodyRenderCacheEntry {
  value: MarkdownBodyRenderResult;
  extensions: readonly MarkdownExtension[];
  bytes: number;
  expiresAt: number;
}

const markdownBodyRenderCache = new Map<string, MarkdownBodyRenderCacheEntry>();
let markdownBodyRenderCacheBytes = 0;

export interface MarkdownRenderCacheStats {
  entryCount: number;
  totalBytes: number;
}

function createMarkdownRenderer(extensions: readonly MarkdownExtension[]): MarkdownIt {
  const renderer = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: false,
  });

  for (const extension of extensions) extension.install(renderer);
  renderer.options.html = false;

  const defaultLinkOpenRenderer = renderer.renderer.rules.link_open
    ?? ((tokens: Token[], idx: number, options: MarkdownRenderOptions, _env: Parameters<Renderer['render']>[2], self: Renderer) => self.renderToken(tokens, idx, options));

  renderer.renderer.rules.link_open = (
    tokens: Token[],
    idx: number,
    options: MarkdownRenderOptions,
    env: Parameters<Renderer['render']>[2],
    self: Renderer,
  ) => {
    const token = tokens[idx];
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpenRenderer(tokens, idx, options, env, self);
  };

  return renderer;
}

const markdownRenderers = new WeakMap<readonly MarkdownExtension[], MarkdownIt>();

function getMarkdownRenderer(extensions: readonly MarkdownExtension[]): MarkdownIt {
  let renderer = markdownRenderers.get(extensions);
  if (!renderer) {
    renderer = createMarkdownRenderer(extensions);
    markdownRenderers.set(extensions, renderer);
  }
  return renderer;
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

function pruneMarkdownRenderCache(now = Date.now()): void {
  for (const [key, entry] of markdownBodyRenderCache.entries()) {
    if (entry.expiresAt > now) {
      continue;
    }
    markdownBodyRenderCache.delete(key);
    markdownBodyRenderCacheBytes = Math.max(0, markdownBodyRenderCacheBytes - entry.bytes);
  }
}

function getRenderedMarkdownFromCache(cacheKey: string, extensions: readonly MarkdownExtension[]): MarkdownBodyRenderResult | undefined {
  const now = Date.now();
  const entry = markdownBodyRenderCache.get(cacheKey);
  if (!entry || entry.extensions !== extensions) {
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

export function peekRenderedMarkdownBody(cacheKey: string, extensions: readonly MarkdownExtension[] = BUILTIN_MARKDOWN_EXTENSIONS): MarkdownBodyRenderResult | undefined {
  return getRenderedMarkdownFromCache(cacheKey, extensions);
}

export function getMarkdownRenderCacheStats(): MarkdownRenderCacheStats {
  pruneMarkdownRenderCache(Date.now());
  return {
    entryCount: markdownBodyRenderCache.size,
    totalBytes: markdownBodyRenderCacheBytes,
  };
}

function rememberRenderedMarkdown(cacheKey: string, value: MarkdownBodyRenderResult, extensions: readonly MarkdownExtension[]): void {
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
    extensions,
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

function renderMarkdownHtml(markdown: string, extensions: readonly MarkdownExtension[]): string {
  return getMarkdownRenderer(extensions).render(rewriteFileHintHrefs(markdown));
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

function buildMarkdownBody(markdown: string, extensions: readonly MarkdownExtension[], cacheKey?: string): MarkdownBodyRenderResult {
  const startedAt = nowMonotonicMs();
  const next = {
    fullHtml: renderMarkdownHtml(markdown, extensions),
  } satisfies MarkdownBodyRenderResult;
  if (cacheKey !== undefined) rememberRenderedMarkdown(cacheKey, next, extensions);
  trackMarkdownProcessCost(markdown, Math.max(0, nowMonotonicMs() - startedAt));
  return next;
}

// Streaming callers retain the current result in their component memo, not every prefix in the LRU.
export function renderStreamingMarkdownBody(markdown: string, extensions: readonly MarkdownExtension[] = BUILTIN_MARKDOWN_EXTENSIONS): MarkdownBodyRenderResult {
  return buildMarkdownBody(markdown, extensions);
}

export function getOrBuildMarkdownBody(
  cacheKey: string,
  input: { markdown: string },
  extensions: readonly MarkdownExtension[] = BUILTIN_MARKDOWN_EXTENSIONS,
): MarkdownBodyRenderResult {
  return getRenderedMarkdownFromCache(cacheKey, extensions) ?? buildMarkdownBody(input.markdown, extensions, cacheKey);
}

export function getOrPrepareMarkdownBody(
  cacheKey: string,
  prepareMarkdown: () => string,
  extensions: readonly MarkdownExtension[] = BUILTIN_MARKDOWN_EXTENSIONS,
): MarkdownBodyRenderResult | undefined {
  const cached = getRenderedMarkdownFromCache(cacheKey, extensions);
  if (cached) return cached;
  const markdown = prepareMarkdown();
  return markdown.trim() ? buildMarkdownBody(markdown, extensions, cacheKey) : undefined;
}

export function prewarmMarkdownBody(
  cacheKey: string,
  input: { markdown: string },
  extensions: readonly MarkdownExtension[] = BUILTIN_MARKDOWN_EXTENSIONS,
): MarkdownBodyRenderResult {
  return getOrBuildMarkdownBody(cacheKey, input, extensions);
}
