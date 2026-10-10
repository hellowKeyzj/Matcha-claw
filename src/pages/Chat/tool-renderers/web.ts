import type { TFunction } from 'i18next';
import type { SessionRenderToolCard } from '../../../types/session/tool-card';
import type { ToolActivityTextBlock, ToolActivityTrailingLabel, ToolActivityContent } from '../tool-activity-view-model';
import { extractToolResultContentBlockText, parseToolResultJson } from './result-content';

const WEB_TOOL_NAMES = new Set([
  'webfetch',
  'web_fetch',
  'web-fetch',
  'websearch',
  'web_search',
  'web-search',
  'browser',
  'fetch',
  'searchweb',
  'search_web',
  'search-web',
  'openurl',
  'open_url',
  'open-url',
]);

type JsonRecord = Record<string, unknown>;

interface WebSearchResult {
  title?: string;
  url?: string;
  summary?: string;
  content?: string;
  status?: string;
}

interface WebToolOutput {
  title?: string;
  url?: string;
  results: WebSearchResult[];
  summary?: string;
  content?: string;
  status?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringField(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const field = readString(value[key]);
    if (field) return field;
  }
  return null;
}

function readArrayField(value: unknown, keys: string[]): unknown[] {
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const field = value[key];
    if (Array.isArray(field)) return field;
  }
  return [];
}

function parseStructuredText(text: string | null | undefined): unknown {
  return parseToolResultJson(text);
}

function parseHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.host || null;
  } catch {
    try {
      const parsed = new URL(`https://${url}`);
      return parsed.host || null;
    } catch {
      return null;
    }
  }
}

function normalizeToolName(name: string): string {
  return name.trim().replace(/\s+/g, '').toLowerCase();
}

function isWebToolName(name: string): boolean {
  return WEB_TOOL_NAMES.has(normalizeToolName(name));
}

function isSearchToolName(name: string): boolean {
  return /search/i.test(name);
}

function firstInputUrl(input: unknown): string | null {
  const direct = readStringField(input, ['url']);
  if (direct) return direct;
  const urls = readArrayField(input, ['urls']);
  for (const item of urls) {
    const url = readString(item) ?? readStringField(item, ['url']);
    if (url) return url;
  }
  return null;
}

function readInput(tool: SessionRenderToolCard): unknown {
  if (isRecord(tool.input)) return tool.input;
  return parseStructuredText(tool.inputText);
}

function readResultPayload(tool: SessionRenderToolCard): unknown {
  if (isRecord(tool.output) || Array.isArray(tool.output)) {
    const contentBlockText = extractToolResultContentBlockText(tool.output);
    if (contentBlockText) return parseStructuredText(contentBlockText) ?? contentBlockText;
    return tool.output;
  }
  const result = tool.result;
  if (result.kind === 'text' || result.kind === 'json') return parseStructuredText(result.bodyText);
  if (result.kind === 'canvas') return parseStructuredText(result.rawText);
  return null;
}

function readPlainResultText(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return null;
  const structuredValue = parseStructuredText(trimmed);
  if (structuredValue !== null) return extractToolResultContentBlockText(structuredValue);
  return trimmed;
}

function readOutputText(tool: SessionRenderToolCard): string | null {
  const outputText = extractToolResultContentBlockText(tool.output);
  if (outputText) return outputText;
  const result = tool.result;
  if (result.kind === 'text' || result.kind === 'json') {
    return readPlainResultText(result.bodyText) ?? readPlainResultText(result.collapsedPreview);
  }
  if (result.kind === 'canvas') {
    return readPlainResultText(result.rawText) ?? readPlainResultText(result.collapsedPreview);
  }
  return null;
}

function readSearchResult(value: unknown): WebSearchResult | null {
  if (!isRecord(value)) return null;
  const title = readStringField(value, ['title']);
  const url = readStringField(value, ['url', 'link']);
  const summary = readStringField(value, ['summary', 'snippet', 'description']);
  const content = readStringField(value, ['content', 'text']);
  const status = readStringField(value, ['status']);
  if (!title && !url && !summary && !content && !status) return null;
  return {
    title: title ?? undefined,
    url: url ?? undefined,
    summary: summary ?? undefined,
    content: content ?? undefined,
    status: status ?? undefined,
  };
}

function readOutput(payload: unknown, fallbackText: string | null): WebToolOutput {
  const root = Array.isArray(payload) ? { results: payload } : payload;
  const results = readArrayField(root, ['results', 'items'])
    .map(readSearchResult)
    .filter((item): item is WebSearchResult => item != null);
  return {
    title: readStringField(root, ['title']) ?? undefined,
    url: readStringField(root, ['url']) ?? undefined,
    results,
    summary: readStringField(root, ['summary']) ?? undefined,
    content: readStringField(root, ['content']) ?? fallbackText ?? undefined,
    status: readStringField(root, ['status']) ?? undefined,
  };
}

function resolveQuery(input: unknown): string | null {
  return readStringField(input, ['query', 'prompt']);
}

function resolveTitle(tool: SessionRenderToolCard, query: string | null, url: string | null, output: WebToolOutput, t: TFunction<'chat'>): string {
  const host = parseHost(url ?? output.url ?? null);
  if (query || isSearchToolName(tool.name)) return t('toolActivity.web.search', { query: query ?? tool.displayDetail?.trim() ?? '' }).trim();
  if (host) return t('toolActivity.web.open', { name: host });
  if (output.title) return t('toolActivity.web.open', { name: output.title });
  return t('toolActivity.web.openPage');
}

function resultSummary(result: WebSearchResult, index: number, t: TFunction<'chat'>): string {
  const title = result.title ?? result.url ?? t('toolActivity.web.result', { index: index + 1 });
  const detail = [result.summary, result.content, result.status].find((value) => value?.trim());
  return [title, result.url, detail].filter(Boolean).join('\n');
}

function buildTextBlocks(query: string | null, url: string | null, output: WebToolOutput, t: TFunction<'chat'>): ToolActivityTextBlock[] {
  const blocks: ToolActivityTextBlock[] = [];
  if (query) {
    blocks.push({ kind: 'input', title: t('toolActivity.web.searchLabel'), text: query, copyable: true });
  }
  if (url) {
    blocks.push({ kind: 'input', title: 'URL', text: url, copyable: true });
  }
  if (output.results.length > 0) {
    blocks.push({
      kind: 'output',
      title: t('toolActivity.resultSummary'),
      text: output.results.map((result, index) => resultSummary(result, index, t)).join('\n\n'),
      copyable: false,
    });
  } else {
    const summary = [output.title, output.url, output.summary, output.content, output.status]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n');
    if (summary) {
      blocks.push({ kind: 'output', title: t('toolActivity.summary'), text: summary, copyable: false });
    }
  }
  return blocks;
}

function buildTrailingLabels(query: string | null, url: string | null, output: WebToolOutput, t: TFunction<'chat'>): ToolActivityTrailingLabel[] {
  const labels: ToolActivityTrailingLabel[] = [];
  const host = parseHost(url ?? output.url ?? null);
  if (host) labels.push({ text: host, tone: 'muted' });
  if (output.results.length > 0) labels.push({ text: t('toolActivity.web.results', { count: output.results.length }), tone: 'muted' });
  if (!host && query) labels.push({ text: t('toolActivity.web.page'), tone: 'muted' });
  return labels;
}

export function canRenderWebToolActivity(tool: SessionRenderToolCard): boolean {
  return isWebToolName(tool.name) || isWebToolName(tool.displayTitle);
}

export function renderWebToolActivity(tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityContent {
  const input = readInput(tool);
  const query = resolveQuery(input);
  const inputUrl = firstInputUrl(input);
  const output = readOutput(readResultPayload(tool), readOutputText(tool));
  const url = inputUrl ?? output.url ?? null;
  const textBlocks = buildTextBlocks(query, url, output, t);

  return {
    title: resolveTitle(tool, query, url, output, t),
    canExpand: textBlocks.length > 0,
    trailingLabels: buildTrailingLabels(query, url, output, t),
    textBlocks,
  };
}

export const webToolActivityRenderer = renderWebToolActivity;
