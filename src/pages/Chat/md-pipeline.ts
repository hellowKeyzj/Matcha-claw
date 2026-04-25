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
export type MarkdownRenderMode = 'streaming' | 'settled';

export interface MarkdownBodyRenderResult {
  fullHtml: string;
  nodes: MarkdownRenderNode[];
}

export type MarkdownRenderNode =
  | {
      kind: 'html';
      key: string;
      html: string;
    }
  | {
      kind: 'csv';
      key: string;
      csv: string;
    }
  | {
      kind: 'markdown_table';
      key: string;
      rows: string[][];
    };

interface MarkdownBodyRenderCacheEntry {
  value: MarkdownBodyRenderResult;
  bytes: number;
  expiresAt: number;
}

const markdownBodyRenderCache = new Map<string, MarkdownBodyRenderCacheEntry>();
let markdownBodyRenderCacheBytes = 0;

function createMarkdownRenderer(mode: MarkdownRenderMode): MarkdownIt {
  const renderer = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: false,
  });

  if (mode === 'streaming') {
    renderer.disable(['table']);
  }

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

const settledMd = createMarkdownRenderer('settled');
const streamingMd = createMarkdownRenderer('streaming');

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

function rememberRenderedMarkdown(cacheKey: string, value: MarkdownBodyRenderResult): void {
  const now = Date.now();
  pruneMarkdownRenderCache(now);
  const bytes = (value.fullHtml.length * 2) + (JSON.stringify(value.nodes).length * 2) + 64;
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

function renderMarkdownHtml(markdown: string, mode: MarkdownRenderMode): string {
  const renderer = mode === 'streaming' ? streamingMd : settledMd;
  return renderer.render(rewriteFileHintHrefs(markdown));
}

const CSV_FENCE_RE = /```csv[^\n\r]*\r?\n([\s\S]*?)\r?\n```/gim;

function parseCsvLine(line: string): string[] | null {
  const columns: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      columns.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (inQuotes) {
    return null;
  }

  columns.push(current);
  return columns;
}

function looksLikePlainCsvLine(line: string, expectedColumns?: number): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (
    trimmed.startsWith('```')
    || trimmed.startsWith('|')
    || trimmed.startsWith('>')
    || /^#{1,6}\s/.test(trimmed)
    || /^[-*+]\s/.test(trimmed)
    || /^\d+\.\s/.test(trimmed)
  ) {
    return false;
  }

  const columns = parseCsvLine(trimmed);
  if (!columns || columns.length < 3) {
    return false;
  }
  if (typeof expectedColumns === 'number' && columns.length !== expectedColumns) {
    return false;
  }
  return columns.some((column) => column.trim().length > 0);
}

function parseMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return null;
  }
  const normalized = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const columns = normalized.split('|').map((column) => column.trim().replace(/\\\|/g, '|'));
  if (columns.length < 2) {
    return null;
  }
  return columns;
}

function isMarkdownTableDividerLine(line: string, expectedColumns: number): boolean {
  const columns = parseMarkdownTableRow(line);
  if (!columns || columns.length !== expectedColumns) {
    return false;
  }
  return columns.every((column) => /^:?-{3,}:?$/.test(column));
}

function looksLikeMarkdownTableHeaderLine(line: string): boolean {
  const columns = parseMarkdownTableRow(line);
  return Boolean(columns && columns.length >= 2 && columns.some((column) => column.length > 0));
}

function buildNodesFromPlainSegment(markdown: string, keyBase: number): MarkdownRenderNode[] {
  const lines = markdown.split(/\r?\n/);
  const nodes: MarkdownRenderNode[] = [];
  const htmlBuffer: string[] = [];

  const flushHtmlBuffer = (lineIndex: number) => {
    const htmlChunk = htmlBuffer.join('\n');
    htmlBuffer.length = 0;
    if (!htmlChunk.trim()) {
      return;
    }
    nodes.push({
      kind: 'html',
      key: `html:${keyBase}:${lineIndex}`,
      html: renderMarkdownHtml(htmlChunk, 'settled'),
    });
  };

  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const fenceStart = lineIndex;
      htmlBuffer.push(line);
      lineIndex += 1;
      while (lineIndex < lines.length) {
        htmlBuffer.push(lines[lineIndex]);
        if (lines[lineIndex].trim().startsWith('```')) {
          lineIndex += 1;
          break;
        }
        lineIndex += 1;
      }
      void fenceStart;
      continue;
    }

    if (
      looksLikeMarkdownTableHeaderLine(line)
      && lineIndex + 1 < lines.length
    ) {
      const headerColumns = parseMarkdownTableRow(line);
      const expectedColumns = headerColumns?.length ?? 0;
      if (expectedColumns >= 2 && isMarkdownTableDividerLine(lines[lineIndex + 1], expectedColumns)) {
        const bodyRows: string[][] = [];
        let nextLineIndex = lineIndex + 2;
        while (nextLineIndex < lines.length) {
          const currentRow = parseMarkdownTableRow(lines[nextLineIndex]);
          if (!currentRow || currentRow.length !== expectedColumns) {
            break;
          }
          bodyRows.push(currentRow);
          nextLineIndex += 1;
        }

        if (bodyRows.length > 0) {
          flushHtmlBuffer(lineIndex);
          nodes.push({
            kind: 'markdown_table',
            key: `markdown-table:${keyBase}:${lineIndex}`,
            rows: [headerColumns!, ...bodyRows],
          });
          lineIndex = nextLineIndex;
          continue;
        }
      }
    }

    if (!looksLikePlainCsvLine(line)) {
      htmlBuffer.push(line);
      lineIndex += 1;
      continue;
    }

    const firstColumns = parseCsvLine(trimmed);
    const expectedColumns = firstColumns?.length;
    if (!expectedColumns || expectedColumns < 3) {
      htmlBuffer.push(line);
      lineIndex += 1;
      continue;
    }

    const csvLines: string[] = [trimmed];
    let nextLineIndex = lineIndex + 1;
    while (nextLineIndex < lines.length && looksLikePlainCsvLine(lines[nextLineIndex], expectedColumns)) {
      csvLines.push(lines[nextLineIndex].trim());
      nextLineIndex += 1;
    }

    if (csvLines.length < 3) {
      htmlBuffer.push(line);
      lineIndex += 1;
      continue;
    }

    flushHtmlBuffer(lineIndex);
    nodes.push({
      kind: 'csv',
      key: `csv:${keyBase}:${lineIndex}`,
      csv: csvLines.join('\n'),
    });
    lineIndex = nextLineIndex;
  }

  flushHtmlBuffer(lines.length);
  return nodes;
}

function buildMarkdownRenderNodes(markdown: string): MarkdownRenderNode[] {
  const nodes: MarkdownRenderNode[] = [];
  let lastIndex = 0;

  for (const match of markdown.matchAll(CSV_FENCE_RE)) {
    const matchIndex = typeof match.index === 'number' ? match.index : -1;
    if (matchIndex < 0) {
      continue;
    }

    const htmlChunk = markdown.slice(lastIndex, matchIndex);
    if (htmlChunk.trim().length > 0) {
      nodes.push(...buildNodesFromPlainSegment(htmlChunk, lastIndex));
    }

    nodes.push({
      kind: 'csv',
      key: `csv:${matchIndex}`,
      csv: match[1] ?? '',
    });
    lastIndex = matchIndex + match[0].length;
  }

  const trailingHtmlChunk = markdown.slice(lastIndex);
  if (trailingHtmlChunk.trim().length > 0) {
    nodes.push(...buildNodesFromPlainSegment(trailingHtmlChunk, lastIndex));
  }

  if (nodes.length === 0) {
    return [{
      kind: 'html',
      key: 'html:0',
      html: renderMarkdownHtml(markdown, 'settled'),
    }];
  }

  return nodes;
}

function buildStreamingRenderNodes(markdown: string): MarkdownRenderNode[] {
  return [{
    kind: 'html',
    key: 'html:0',
    html: renderMarkdownHtml(markdown, 'streaming'),
  }];
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
  input: { markdown: string; mode?: MarkdownRenderMode },
): MarkdownBodyRenderResult {
  const cached = getRenderedMarkdownFromCache(cacheKey);
  if (cached) {
    return cached;
  }

  const startedAt = nowMonotonicMs();
  const renderMode = input.mode ?? 'settled';
  const next = {
    fullHtml: renderMarkdownHtml(input.markdown, renderMode),
    nodes: renderMode === 'streaming'
      ? buildStreamingRenderNodes(input.markdown)
      : buildMarkdownRenderNodes(input.markdown),
  } satisfies MarkdownBodyRenderResult;
  rememberRenderedMarkdown(cacheKey, next);
  trackMarkdownProcessCost(input.markdown, Math.max(0, nowMonotonicMs() - startedAt));
  return next;
}
