import type {
  SessionRenderToolCard,
  SessionRenderToolStatusKind,
} from '../../../types/session/tool-card';
import type { ToolActivityTextBlock, ToolActivityTrailingLabel, ToolActivityViewModel } from '../tool-activity-view-model';
import { extractToolResultContentBlockText, parseToolResultJson } from './result-content';

const NON_ACTIVITY_TITLE_TEXT = new Set([
  '失败',
  '错误',
  '运行中',
  '完成',
  '无结果',
  'failed',
  'error',
  'running',
  'completed',
  'missing result',
]);
const BLOCK_TEXT_LIMIT = 4000;
const DETAILS_TEXT_LIMIT = 2000;
const STRING_PREVIEW_LIMIT = 96;
const MAX_PUBLIC_SUMMARY_KEYS = 12;
const MAX_PUBLIC_SUMMARY_FIELDS = 8;
const MAX_PUBLIC_SUMMARY_LINES = 12;
const PUBLIC_DETAIL_KEYS = new Set([
  'changed',
  'created',
  'diff',
  'patch',
  'truncation',
  'fullOutputPath',
  'exitCode',
]);
const BLOCKED_DETAIL_KEYS = new Set([
  'browsertab',
  'mcpapppreview',
  'approvalreviews',
  'approvalreviewoutcome',
  'progresscard',
  'progresscardreceipt',
  'receipt',
  'private',
  'privatepayload',
  'raw',
  'rawassistanttext',
  'sourcereply',
  'toolinput',
  'tooloutput',
  'input',
  'output',
  'secret',
]);

type JsonRecord = Record<string, unknown>;
type ToolCardWithDetails = SessionRenderToolCard & { details?: unknown };

function formatToolDuration(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStructuredText(text: string): unknown {
  return parseToolResultJson(text);
}

function truncateText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}\n… 已截断 ${trimmed.length - limit} 字符`;
}

function publicKeys(value: JsonRecord): string[] {
  return Object.keys(value).filter((key) => !isBlockedDetailKey(key));
}

function hasUnsafePreviewText(text: string): boolean {
  const normalized = text.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized.includes('private')
    || normalized.includes('raw')
    || normalized.includes('sourcereply')
    || normalized.includes('toolinput')
    || normalized.includes('tooloutput')
    || normalized.includes('secret');
}

function stringPreview(text: string): string | null {
  const preview = text.trim().replace(/\s+/g, ' ');
  if (!preview || hasUnsafePreviewText(preview)) return null;
  return preview.length <= STRING_PREVIEW_LIMIT ? preview : `${preview.slice(0, STRING_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

function summarizeString(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = parseStructuredText(trimmed);
  if (isRecord(parsed) || Array.isArray(parsed)) return summarizePublicValue(parsed);
  const preview = stringPreview(trimmed);
  return preview ? `字符串：${trimmed.length} 字符；preview: ${preview}` : `字符串：${trimmed.length} 字符`;
}

function summarizeArray(value: unknown[]): string {
  return `数组：${value.length} 项`;
}

function summarizeRecordShape(value: JsonRecord): string | null {
  const keys = publicKeys(value);
  if (keys.length === 0) return null;
  const visibleKeys = keys.slice(0, MAX_PUBLIC_SUMMARY_KEYS).map((key) => JSON.stringify(key));
  const suffix = keys.length > visibleKeys.length ? `, +${keys.length - visibleKeys.length}` : '';
  return `对象：${keys.length} keys（${visibleKeys.join(', ')}${suffix}）`;
}

function normalizePublicFieldKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isAllowedPublicFieldKey(key: string): boolean {
  const normalized = normalizePublicFieldKey(key);
  if (!normalized || isBlockedDetailKey(key)) return false;
  return normalized === 'exit'
    || normalized === 'exitcode'
    || normalized === 'code'
    || normalized === 'status'
    || normalized === 'state'
    || normalized === 'phase'
    || normalized === 'count'
    || normalized === 'total'
    || normalized.endsWith('count')
    || normalized === 'bytes'
    || normalized.endsWith('bytes')
    || normalized === 'size'
    || normalized.endsWith('size')
    || normalized === 'path'
    || normalized.endsWith('path')
    || normalized === 'ref'
    || normalized.endsWith('ref')
    || normalized === 'reference'
    || normalized.endsWith('reference');
}

function summarizeFieldValue(value: unknown, includeStringPreview: boolean): string | null {
  if (value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!includeStringPreview) return `字符串：${trimmed.length} 字符`;
    const preview = stringPreview(trimmed);
    return preview ?? `字符串：${trimmed.length} 字符`;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return summarizeArray(value);
  if (isRecord(value)) return summarizeRecordShape(value);
  return null;
}

function summarizePublicValue(value: unknown): string | null {
  if (typeof value === 'string') return summarizeString(value);
  const contentBlockText = extractToolResultContentBlockText(value);
  if (contentBlockText) return summarizeString(contentBlockText);
  if (Array.isArray(value)) return summarizeArray(value);
  if (!isRecord(value)) return summarizeFieldValue(value, true);

  const lines = [summarizeRecordShape(value)].filter((line): line is string => line != null);
  let fieldCount = 0;
  for (const [key, field] of Object.entries(value)) {
    if (fieldCount >= MAX_PUBLIC_SUMMARY_FIELDS || isBlockedDetailKey(key)) continue;
    const valueSummary = summarizeFieldValue(field, isAllowedPublicFieldKey(key));
    if (!valueSummary) continue;
    lines.push(`${key}: ${valueSummary}`);
    fieldCount += 1;
  }
  return lines.length > 0 ? lines.slice(0, MAX_PUBLIC_SUMMARY_LINES).join('\n') : null;
}

function serializePublicSummary(value: unknown, limit: number): string | null {
  const summary = summarizePublicValue(value);
  return summary ? truncateText(summary, limit) : null;
}

function isBlockedDetailKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (BLOCKED_DETAIL_KEYS.has(normalized)) return true;
  return normalized.includes('private')
    || normalized.includes('raw')
    || normalized.includes('sourcereply')
    || normalized.includes('toolinput')
    || normalized.includes('tooloutput')
    || normalized.includes('secret')
    || normalized === 'input'
    || normalized === 'output';
}

function filterPublicDetailValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(filterPublicDetailValue);
  if (!isRecord(value)) return value;
  const details: JsonRecord = {};
  for (const [key, field] of Object.entries(value)) {
    if (!isBlockedDetailKey(key)) details[key] = filterPublicDetailValue(field);
  }
  return details;
}

function projectPublicDetails(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const details: JsonRecord = {};
  for (const key of PUBLIC_DETAIL_KEYS) {
    if (key in value) details[key] = filterPublicDetailValue(value[key]);
  }
  return Object.keys(details).length > 0 ? details : null;
}

function hasDetailsContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDetailsContent);
  if (isRecord(value)) return Object.values(value).some(hasDetailsContent);
  if (typeof value === 'string') return value.trim().length > 0;
  return value != null;
}

function serializeDetails(value: unknown): string | null {
  const details = projectPublicDetails(value);
  if (!hasDetailsContent(details)) return null;
  return serializePublicSummary(details, DETAILS_TEXT_LIMIT);
}

function isMeaningfulActivityText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.length > 0 && !NON_ACTIVITY_TITLE_TEXT.has(normalized);
}

function isMeaningfulToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'tool' && !NON_ACTIVITY_TITLE_TEXT.has(normalized);
}

function resolveActivityTitle(input: {
  primaryTitle: string;
  detailTitle: string;
  summary?: string;
}): string {
  const detailTitle = input.detailTitle.trim();
  if (detailTitle !== input.primaryTitle && isMeaningfulActivityText(detailTitle)) return detailTitle;

  const summary = input.summary?.trim() ?? '';
  if (summary.length <= 96 && isMeaningfulActivityText(summary)) return summary;

  if (isMeaningfulToolName(input.primaryTitle)) return `调用 ${input.primaryTitle.trim()}`;
  return '工具调用';
}

function resolveToolTone(status: SessionRenderToolStatusKind): ToolActivityViewModel['tone'] {
  if (status === 'running') return 'running';
  if (status === 'error') return 'danger';
  if (status === 'missing_result') return 'muted';
  return 'neutral';
}

function buildTrailingLabels(tool: SessionRenderToolCard, title: string): ToolActivityTrailingLabel[] {
  const labels: ToolActivityTrailingLabel[] = [];
  if (tool.status === 'running' && title !== '运行中') labels.push({ text: '运行中', tone: 'muted' });
  if (tool.status === 'missing_result' && title !== '无结果') labels.push({ text: '无结果', tone: 'muted' });
  const durationLabel = formatToolDuration(tool.durationMs);
  if (durationLabel) labels.push({ text: durationLabel, tone: 'muted' });
  return labels;
}

function readOutputText(tool: SessionRenderToolCard): string | null {
  const outputSummary = serializePublicSummary(tool.output, BLOCK_TEXT_LIMIT);
  if (outputSummary) return outputSummary;
  const result = tool.result;
  if (result.kind === 'text' || result.kind === 'json') {
    return serializePublicSummary(parseToolResultJson(result.bodyText) ?? result.bodyText, BLOCK_TEXT_LIMIT)
      ?? serializePublicSummary(result.collapsedPreview, BLOCK_TEXT_LIMIT);
  }
  if (result.kind === 'canvas') {
    return serializePublicSummary(parseToolResultJson(result.rawText) ?? result.rawText, BLOCK_TEXT_LIMIT);
  }
  return null;
}

function readDetailsText(tool: SessionRenderToolCard): string | null {
  return serializeDetails((tool as ToolCardWithDetails).details);
}

function buildTextBlocks(tool: SessionRenderToolCard, hasAssistantCanvas: boolean): ToolActivityTextBlock[] {
  const blocks: ToolActivityTextBlock[] = [];
  const inputText = serializePublicSummary(tool.input, BLOCK_TEXT_LIMIT)
    ?? serializePublicSummary(parseStructuredText(tool.inputText ?? ''), BLOCK_TEXT_LIMIT)
    ?? serializePublicSummary(tool.inputText ?? '', BLOCK_TEXT_LIMIT);
  if (inputText) blocks.push({ kind: 'input', title: '输入', text: inputText, copyable: true });

  if (hasAssistantCanvas) {
    blocks.push({
      kind: 'notice',
      text: '预览已显示在助手消息里。',
      copyable: false,
    });
  }

  const outputText = readOutputText(tool);
  if (outputText) {
    blocks.push({
      kind: 'output',
      title: '输出',
      text: truncateText(outputText, BLOCK_TEXT_LIMIT),
      copyable: false,
    });
  }

  const detailsText = readDetailsText(tool);
  if (detailsText) {
    blocks.push({
      kind: 'output',
      title: '详情',
      text: detailsText,
      copyable: false,
    });
  }

  return blocks;
}

export function genericToolActivityRenderer(tool: SessionRenderToolCard): ToolActivityViewModel {
  const primaryTitle = tool.displayTitle?.trim() || tool.name?.trim() || '';
  const title = resolveActivityTitle({
    primaryTitle,
    detailTitle: tool.displayDetail?.trim() ?? '',
    summary: tool.summary,
  });
  const result = tool.result;
  const hasAssistantCanvas = result.kind === 'canvas' && result.preview.kind === 'canvas' && !!result.preview.url;
  const canvasPreview = hasAssistantCanvas
    ? {
      title: result.preview.title?.trim() || tool.name || title,
      url: result.preview.url,
      preferredHeight: result.preview.preferredHeight,
      rawText: result.rawText?.trim() ? truncateText(result.rawText, BLOCK_TEXT_LIMIT) : undefined,
    }
    : undefined;
  const textBlocks = buildTextBlocks(tool, hasAssistantCanvas);

  return {
    title,
    tone: resolveToolTone(tool.status),
    isRunning: tool.status === 'running',
    isError: tool.status === 'error',
    canExpand: textBlocks.length > 0 || canvasPreview != null,
    trailingLabels: buildTrailingLabels(tool, title),
    textBlocks,
    canvasPreview,
  };
}
