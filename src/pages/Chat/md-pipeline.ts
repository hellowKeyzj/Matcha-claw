import { trackUiTiming } from '@/lib/telemetry';
import type { AttachedFileMeta } from '@/stores/chat';

const MARKDOWN_RENDER_CACHE_TTL_MS = 10 * 60_000;
const MARKDOWN_RENDER_CACHE_MAX_ENTRIES = 240;
const MARKDOWN_RENDER_CACHE_MAX_BYTES = 3 * 1024 * 1024;
const MARKDOWN_RICH_READY_TTL_MS = 10 * 60_000;
const MARKDOWN_RICH_READY_MAX_ENTRIES = 400;
const MARKDOWN_RICH_RENDER_BATCH_SIZE = 1;
const MARKDOWN_PROCESS_METRIC_MIN_CHARS = 256;
const MARKDOWN_PROCESS_METRIC_MIN_DURATION_MS = 2;

export const MARKDOWN_DEFER_SCORE_THRESHOLD = 220;
export const MARKDOWN_VISIBILITY_ROOT_MARGIN = '320px 0px';

interface MarkdownCacheEntry {
  value: string;
  bytes: number;
  expiresAt: number;
}

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining: () => number;
}

type IdleCallbackHandle = number | ReturnType<typeof setTimeout>;
type IdleCallback = (deadline: IdleDeadlineLike) => void;

const markdownRenderCache = new Map<string, MarkdownCacheEntry>();
let markdownRenderCacheBytes = 0;
const markdownRichReadyCache = new Map<string, number>();
const markdownRichRenderQueue: string[] = [];
const markdownRichRenderQueuedSet = new Set<string>();
const markdownRichRenderQueuedAt = new Map<string, number>();
const markdownRichRenderListeners = new Map<string, Set<() => void>>();
let markdownRichRenderDrainHandle: IdleCallbackHandle | null = null;

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

export function estimateMarkdownRenderScore(text: string): number {
  if (!text) {
    return 0;
  }
  const lineBreaks = text.match(/\n/g)?.length ?? 0;
  const codeFenceCount = text.match(/```/g)?.length ?? 0;
  const linkCount = text.match(/\[[^\]\n]+\]\([^)]+\)/g)?.length ?? 0;
  const headingCount = text.match(/^#{1,6}\s/mg)?.length ?? 0;
  const tableHint = text.includes('|') && text.includes('\n') ? 1 : 0;
  return (
    Math.ceil(text.length / 80)
    + lineBreaks * 2
    + codeFenceCount * 36
    + linkCount * 6
    + headingCount * 4
    + tableHint * 20
  );
}

function scheduleIdleCallback(callback: IdleCallback): IdleCallbackHandle {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      requestIdleCallback?: (cb: IdleCallback, options?: { timeout?: number }) => number;
    };
    if (typeof win.requestIdleCallback === 'function') {
      return win.requestIdleCallback(callback, { timeout: 120 });
    }
  }
  return setTimeout(() => {
    callback({
      didTimeout: true,
      timeRemaining: () => 0,
    });
  }, 0);
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

export function hasRichReadyCache(cacheKey: string): boolean {
  const expiresAt = markdownRichReadyCache.get(cacheKey);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    markdownRichReadyCache.delete(cacheKey);
    return false;
  }
  return true;
}

export function markRichReadyCache(cacheKey: string): void {
  const now = Date.now();
  markdownRichReadyCache.set(cacheKey, now + MARKDOWN_RICH_READY_TTL_MS);
  while (markdownRichReadyCache.size > MARKDOWN_RICH_READY_MAX_ENTRIES) {
    const oldestKey = markdownRichReadyCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    markdownRichReadyCache.delete(oldestKey);
  }
}

function removeQueuedMarkdownRichRender(cacheKey: string): void {
  markdownRichRenderQueuedSet.delete(cacheKey);
  markdownRichRenderQueuedAt.delete(cacheKey);
  const index = markdownRichRenderQueue.indexOf(cacheKey);
  if (index >= 0) {
    markdownRichRenderQueue.splice(index, 1);
  }
}

function scheduleMarkdownRichRenderDrain(): void {
  if (markdownRichRenderDrainHandle != null) {
    return;
  }
  markdownRichRenderDrainHandle = scheduleIdleCallback((deadline) => {
    const batchStartedAt = nowMonotonicMs();
    markdownRichRenderDrainHandle = null;
    let processed = 0;
    while (markdownRichRenderQueue.length > 0 && processed < MARKDOWN_RICH_RENDER_BATCH_SIZE) {
      const cacheKey = markdownRichRenderQueue.shift();
      if (!cacheKey) {
        continue;
      }
      markdownRichRenderQueuedSet.delete(cacheKey);
      const queuedAt = markdownRichRenderQueuedAt.get(cacheKey);
      markdownRichRenderQueuedAt.delete(cacheKey);
      if (typeof queuedAt === 'number') {
        trackUiTiming('chat.md_rich_wait', Math.max(0, nowMonotonicMs() - queuedAt), {
          remaining: markdownRichRenderQueue.length,
        });
      }
      markRichReadyCache(cacheKey);
      const listeners = markdownRichRenderListeners.get(cacheKey);
      if (listeners && listeners.size > 0) {
        markdownRichRenderListeners.delete(cacheKey);
        for (const listener of listeners) {
          listener();
        }
      }
      processed += 1;
      if (!deadline.didTimeout && deadline.timeRemaining() <= 2) {
        break;
      }
    }
    if (processed > 0) {
      trackUiTiming('chat.md_rich_batch_cost', Math.max(0, nowMonotonicMs() - batchStartedAt), {
        processed,
        remaining: markdownRichRenderQueue.length,
      });
    }
    if (markdownRichRenderQueue.length > 0) {
      scheduleMarkdownRichRenderDrain();
    }
  });
}

export function requestMarkdownRichRender(cacheKey: string, onReady: () => void): () => void {
  if (hasRichReadyCache(cacheKey)) {
    onReady();
    return () => {};
  }

  let listeners = markdownRichRenderListeners.get(cacheKey);
  if (!listeners) {
    listeners = new Set();
    markdownRichRenderListeners.set(cacheKey, listeners);
  }
  listeners.add(onReady);

  if (!markdownRichRenderQueuedSet.has(cacheKey)) {
    markdownRichRenderQueuedSet.add(cacheKey);
    markdownRichRenderQueuedAt.set(cacheKey, nowMonotonicMs());
    markdownRichRenderQueue.push(cacheKey);
    scheduleMarkdownRichRenderDrain();
  }

  return () => {
    const current = markdownRichRenderListeners.get(cacheKey);
    if (!current) {
      return;
    }
    current.delete(onReady);
    if (current.size === 0) {
      markdownRichRenderListeners.delete(cacheKey);
      removeQueuedMarkdownRichRender(cacheKey);
    }
  };
}
