import { trackUiTiming } from '@/lib/telemetry';
import type { AttachedFileMeta } from '@/stores/chat';

const MARKDOWN_RENDER_CACHE_TTL_MS = 10 * 60_000;
const MARKDOWN_RENDER_CACHE_MAX_ENTRIES = 240;
const MARKDOWN_RENDER_CACHE_MAX_BYTES = 3 * 1024 * 1024;
const MARKDOWN_PROCESS_METRIC_MIN_CHARS = 256;
const MARKDOWN_PROCESS_METRIC_MIN_DURATION_MS = 2;

interface MarkdownCacheEntry {
  value: string;
  bytes: number;
  expiresAt: number;
}

const markdownRenderCache = new Map<string, MarkdownCacheEntry>();
let markdownRenderCacheBytes = 0;

export function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
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

function pruneMarkdownRenderCache(now = Date.now()): void {
  for (const [key, entry] of markdownRenderCache.entries()) {
    if (entry.expiresAt > now) {
      continue;
    }
    markdownRenderCache.delete(key);
    markdownRenderCacheBytes = Math.max(0, markdownRenderCacheBytes - entry.bytes);
  }
}

function getProcessedMarkdownFromCache(cacheKey: string): string | undefined {
  const now = Date.now();
  const entry = markdownRenderCache.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    markdownRenderCache.delete(cacheKey);
    markdownRenderCacheBytes = Math.max(0, markdownRenderCacheBytes - entry.bytes);
    return undefined;
  }
  markdownRenderCache.delete(cacheKey);
  markdownRenderCache.set(cacheKey, {
    ...entry,
    expiresAt: now + MARKDOWN_RENDER_CACHE_TTL_MS,
  });
  return entry.value;
}

function rememberProcessedMarkdown(cacheKey: string, value: string): void {
  const now = Date.now();
  pruneMarkdownRenderCache(now);
  const bytes = value.length * 2;
  const previous = markdownRenderCache.get(cacheKey);
  if (previous) {
    markdownRenderCache.delete(cacheKey);
    markdownRenderCacheBytes = Math.max(0, markdownRenderCacheBytes - previous.bytes);
  }

  markdownRenderCache.set(cacheKey, {
    value,
    bytes,
    expiresAt: now + MARKDOWN_RENDER_CACHE_TTL_MS,
  });
  markdownRenderCacheBytes += bytes;

  while (
    markdownRenderCache.size > MARKDOWN_RENDER_CACHE_MAX_ENTRIES
    || markdownRenderCacheBytes > MARKDOWN_RENDER_CACHE_MAX_BYTES
  ) {
    const oldestKey = markdownRenderCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    const oldest = markdownRenderCache.get(oldestKey);
    markdownRenderCache.delete(oldestKey);
    markdownRenderCacheBytes = Math.max(0, markdownRenderCacheBytes - (oldest?.bytes ?? 0));
  }
}

export function getOrBuildProcessedMarkdown(cacheKey: string, builder: () => string): string {
  const cached = getProcessedMarkdownFromCache(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const startedAt = nowMonotonicMs();
  const built = builder();
  rememberProcessedMarkdown(cacheKey, built);
  const durationMs = Math.max(0, nowMonotonicMs() - startedAt);
  if (
    built.length >= MARKDOWN_PROCESS_METRIC_MIN_CHARS
    || durationMs >= MARKDOWN_PROCESS_METRIC_MIN_DURATION_MS
  ) {
    trackUiTiming('chat.md_process_cost', durationMs, {
      cacheState: 'miss',
      chars: built.length,
    });
  }
  return built;
}
