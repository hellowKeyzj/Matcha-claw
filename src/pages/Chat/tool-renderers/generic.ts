import type { TFunction } from 'i18next';
import type { SessionRenderToolCard } from '../../../types/session/tool-card';
import type { ToolActivityTextBlock, ToolActivityTrailingLabel, ToolActivityContent } from '../tool-activity-view-model';
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

function truncateText(text: string, limit: number, t: TFunction<'chat'>): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}\n${t('toolActivity.generic.truncated', { count: trimmed.length - limit })}`;
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

function summarizeString(text: string, t: TFunction<'chat'>): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = parseStructuredText(trimmed);
  if (isRecord(parsed) || Array.isArray(parsed)) return summarizePublicValue(parsed, t);
  const preview = stringPreview(trimmed);
  return preview ? t('toolActivity.generic.stringPreview', { count: trimmed.length, preview }) : t('toolActivity.generic.string', { count: trimmed.length });
}

function summarizeArray(value: unknown[], t: TFunction<'chat'>): string {
  return t('toolActivity.generic.array', { count: value.length });
}

function summarizeRecordShape(value: JsonRecord, t: TFunction<'chat'>): string | null {
  const keys = publicKeys(value);
  if (keys.length === 0) return null;
  const visibleKeys = keys.slice(0, MAX_PUBLIC_SUMMARY_KEYS).map((key) => JSON.stringify(key));
  const suffix = keys.length > visibleKeys.length ? `, +${keys.length - visibleKeys.length}` : '';
  return t('toolActivity.generic.object', { count: keys.length, keys: `${visibleKeys.join(', ')}${suffix}` });
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

function summarizeFieldValue(value: unknown, includeStringPreview: boolean, t: TFunction<'chat'>): string | null {
  if (value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!includeStringPreview) return t('toolActivity.generic.string', { count: trimmed.length });
    const preview = stringPreview(trimmed);
    return preview ?? t('toolActivity.generic.string', { count: trimmed.length });
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return summarizeArray(value, t);
  if (isRecord(value)) return summarizeRecordShape(value, t);
  return null;
}

function summarizePublicValue(value: unknown, t: TFunction<'chat'>): string | null {
  if (typeof value === 'string') return summarizeString(value, t);
  const contentBlockText = extractToolResultContentBlockText(value);
  if (contentBlockText) return summarizeString(contentBlockText, t);
  if (Array.isArray(value)) return summarizeArray(value, t);
  if (!isRecord(value)) return summarizeFieldValue(value, true, t);

  const lines = [summarizeRecordShape(value, t)].filter((line): line is string => line != null);
  let fieldCount = 0;
  for (const [key, field] of Object.entries(value)) {
    if (fieldCount >= MAX_PUBLIC_SUMMARY_FIELDS || isBlockedDetailKey(key)) continue;
    const valueSummary = summarizeFieldValue(field, isAllowedPublicFieldKey(key), t);
    if (!valueSummary) continue;
    lines.push(`${key}: ${valueSummary}`);
    fieldCount += 1;
  }
  return lines.length > 0 ? lines.slice(0, MAX_PUBLIC_SUMMARY_LINES).join('\n') : null;
}

function serializePublicSummary(value: unknown, limit: number, t: TFunction<'chat'>): string | null {
  const summary = summarizePublicValue(value, t);
  return summary ? truncateText(summary, limit, t) : null;
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

function serializeDetails(value: unknown, t: TFunction<'chat'>): string | null {
  const details = projectPublicDetails(value);
  if (!hasDetailsContent(details)) return null;
  return serializePublicSummary(details, DETAILS_TEXT_LIMIT, t);
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
}, t: TFunction<'chat'>): string {
  const detailTitle = input.detailTitle.trim();
  if (detailTitle !== input.primaryTitle && isMeaningfulActivityText(detailTitle)) return detailTitle;

  const summary = input.summary?.trim() ?? '';
  if (summary.length <= 96 && isMeaningfulActivityText(summary)) return summary;

  if (isMeaningfulToolName(input.primaryTitle)) return t('toolActivity.generic.call', { name: input.primaryTitle.trim() });
  return t('toolActivity.generic.toolCall');
}

function buildTrailingLabels(tool: SessionRenderToolCard): ToolActivityTrailingLabel[] {
  const labels: ToolActivityTrailingLabel[] = [];
  const durationLabel = formatToolDuration(tool.durationMs);
  if (durationLabel) labels.push({ text: durationLabel, tone: 'muted' });
  return labels;
}

function readOutputText(tool: SessionRenderToolCard, t: TFunction<'chat'>): string | null {
  const outputSummary = serializePublicSummary(tool.output, BLOCK_TEXT_LIMIT, t);
  if (outputSummary) return outputSummary;
  const result = tool.result;
  if (result.kind === 'text' || result.kind === 'json') {
    return serializePublicSummary(parseToolResultJson(result.bodyText) ?? result.bodyText, BLOCK_TEXT_LIMIT, t)
      ?? serializePublicSummary(result.collapsedPreview, BLOCK_TEXT_LIMIT, t);
  }
  if (result.kind === 'canvas') {
    return serializePublicSummary(parseToolResultJson(result.rawText) ?? result.rawText, BLOCK_TEXT_LIMIT, t);
  }
  return null;
}

function readDetailsText(tool: SessionRenderToolCard, t: TFunction<'chat'>): string | null {
  return serializeDetails((tool as ToolCardWithDetails).details, t);
}

function buildTextBlocks(tool: SessionRenderToolCard, hasAssistantCanvas: boolean, t: TFunction<'chat'>): ToolActivityTextBlock[] {
  const blocks: ToolActivityTextBlock[] = [];
  const inputText = serializePublicSummary(tool.input, BLOCK_TEXT_LIMIT, t)
    ?? serializePublicSummary(parseStructuredText(tool.inputText ?? ''), BLOCK_TEXT_LIMIT, t)
    ?? serializePublicSummary(tool.inputText ?? '', BLOCK_TEXT_LIMIT, t);
  if (inputText) blocks.push({ kind: 'input', title: t('toolActivity.input'), text: inputText, copyable: true });

  if (hasAssistantCanvas) {
    blocks.push({
      kind: 'notice',
      text: t('toolActivity.generic.assistantPreview'),
      copyable: false,
    });
  }

  const outputText = readOutputText(tool, t);
  if (outputText) {
    blocks.push({
      kind: 'output',
      title: t('toolActivity.output'),
      text: truncateText(outputText, BLOCK_TEXT_LIMIT, t),
      copyable: false,
    });
  }

  const detailsText = readDetailsText(tool, t);
  if (detailsText) {
    blocks.push({
      kind: 'details',
      title: t('toolActivity.details'),
      text: detailsText,
      copyable: false,
    });
  }

  return blocks;
}

export function genericToolActivityRenderer(tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityContent {
  const primaryTitle = tool.displayTitle?.trim() || tool.name?.trim() || '';
  const title = resolveActivityTitle({
    primaryTitle,
    detailTitle: tool.displayDetail?.trim() ?? '',
    summary: tool.summary,
  }, t);
  const result = tool.result;
  const hasAssistantCanvas = result.kind === 'canvas' && result.preview.kind === 'canvas' && !!result.preview.url;
  const canvasPreview = hasAssistantCanvas
    ? {
      title: result.preview.title?.trim() || tool.name || title,
      url: result.preview.url,
      preferredHeight: result.preview.preferredHeight,
      rawText: result.rawText?.trim() ? truncateText(result.rawText, BLOCK_TEXT_LIMIT, t) : undefined,
    }
    : undefined;
  const textBlocks = buildTextBlocks(tool, hasAssistantCanvas, t);

  return {
    title,
    canExpand: textBlocks.length > 0 || canvasPreview != null,
    trailingLabels: buildTrailingLabels(tool),
    textBlocks,
    canvasPreview,
  };
}
