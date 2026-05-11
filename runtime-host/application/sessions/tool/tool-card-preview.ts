import type {
  SessionRenderToolPreview,
} from '../../../shared/session-adapter-types';
import {
  isRecord,
  normalizeFiniteNumber,
  normalizeOptionalString,
  normalizePreviewLine,
  previewText,
} from './tool-card-utils';

interface JsonDetectionResult {
  pretty: string;
  summary: string;
}

interface CanvasViewRecord {
  backend?: unknown;
  id?: unknown;
  url?: unknown;
  title?: unknown;
  preferred_height?: unknown;
  preferredHeight?: unknown;
}

interface CanvasPresentationRecord {
  target?: unknown;
  title?: unknown;
  preferred_height?: unknown;
  preferredHeight?: unknown;
}

interface CanvasPayloadRecord {
  kind?: unknown;
  view?: CanvasViewRecord;
  presentation?: CanvasPresentationRecord;
  source?: { type?: unknown };
}

function serializeSymbol(value: symbol): string {
  return value.description ? `Symbol(${value.description})` : 'Symbol()';
}

export function serializeToolPayload(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (typeof value === 'symbol') {
    return serializeSymbol(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function detectJsonText(value: string | undefined): JsonDetectionResult | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return null;
  }
  if (
    (!trimmed.startsWith('{') || !trimmed.endsWith('}'))
    && (!trimmed.startsWith('[') || !trimmed.endsWith(']'))
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return {
      pretty: JSON.stringify(parsed, null, 2),
      summary: buildJsonPreviewSummary(parsed),
    };
  } catch {
    return null;
  }
}

function buildJsonPreviewSummary(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '空列表';
    }
    const first = value[0];
    if (typeof first === 'string' && first.trim()) {
      return `${value.length} 项：${previewText(first, 28)}`;
    }
    return `共 ${value.length} 项`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return '空结果';
    }

    for (const key of ['error', 'reason']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return `失败：${previewText(candidate, 32)}`;
      }
    }

    for (const key of ['text', 'content', 'message', 'result', 'summary', 'title']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return previewText(candidate, 40);
      }
    }

    for (const key of ['items', 'results', 'data', 'rows', 'files', 'matches']) {
      const candidate = value[key];
      if (Array.isArray(candidate)) {
        return candidate.length === 0 ? '空结果' : `共 ${candidate.length} 项`;
      }
    }

    if (typeof value.status === 'string' && value.status.trim()) {
      return `状态：${previewText(value.status, 24)}`;
    }
    if (keys.length <= 4) {
      return `包含 ${keys.join('、')}`;
    }
    return `返回 ${keys.length} 个字段`;
  }
  return '结构化结果';
}

function parseCanvasPayload(value: unknown): CanvasPayloadRecord | null {
  if (isRecord(value)) {
    return value as CanvasPayloadRecord;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed as CanvasPayloadRecord : null;
  } catch {
    return null;
  }
}

export function extractCanvasToolPreview(
  value: unknown,
  fallbackToolName?: string,
): SessionRenderToolPreview | undefined {
  const payload = parseCanvasPayload(value);
  if (!payload || payload.kind !== 'canvas') {
    return undefined;
  }
  if (payload.source?.type === 'html') {
    return undefined;
  }
  const view = isRecord(payload.view) ? payload.view : null;
  const presentation = isRecord(payload.presentation) ? payload.presentation : null;
  const target = normalizeOptionalString(presentation?.target);
  if (target !== 'assistant_message') {
    return undefined;
  }
  const viewId = normalizeOptionalString(view?.id);
  const url = normalizeOptionalString(view?.url);
  if (!viewId || !url) {
    return undefined;
  }
  const title = normalizeOptionalString(
    presentation?.title
    ?? view?.title
    ?? fallbackToolName,
  );
  const preferredHeight = normalizeFiniteNumber(
    presentation?.preferred_height
    ?? presentation?.preferredHeight
    ?? view?.preferred_height
    ?? view?.preferredHeight,
  );
  return {
    kind: 'canvas',
    surface: 'assistant_message',
    render: 'url',
    viewId,
    url,
    ...(title ? { title } : {}),
    ...(preferredHeight != null ? { preferredHeight } : {}),
  };
}

export function buildCanvasPreviewSummary(preview: SessionRenderToolPreview | undefined): string {
  if (!preview || preview.kind !== 'canvas') {
    return '已生成画布结果';
  }
  const title = normalizeOptionalString(preview.title);
  return title ? `已生成画布：${title}` : '已生成画布结果';
}

function stripStructuredPreviewNoise(value: string): string {
  return value
    .replace(/^#+\s*/g, '')
    .replace(/^diff\s+/i, '')
    .replace(/^---+\s*/g, '')
    .replace(/^@@\s*/g, '')
    .trim();
}

function extractObjectLikeField(text: string, field: string): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`(?:^|[\\s,{])["']?${escapedField}["']?\\s*:\\s*"([^"]+)"`, 'i'),
    new RegExp(`(?:^|[\\s,{])["']?${escapedField}["']?\\s*:\\s*'([^']+)'`, 'i'),
    new RegExp(`(?:^|[\\s,{])["']?${escapedField}["']?\\s*:\\s*([^,}\\n]+)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractLooseStructuredChunk(text: string): string {
  const trimmed = text.trim();
  const braceIndex = Math.max(trimmed.indexOf('{'), trimmed.indexOf('---'));
  if (braceIndex > 0) {
    return trimmed.slice(braceIndex);
  }
  return trimmed;
}

function buildObjectLikePreview(text: string): string | undefined {
  const trimmed = extractLooseStructuredChunk(text);
  if (!trimmed.includes(':')) {
    return undefined;
  }

  const message = [
    'message',
    'summary',
    'title',
    'text',
    'result',
    'content',
  ]
    .map((field) => extractObjectLikeField(trimmed, field))
    .find((value) => Boolean(value));
  const error = ['error', 'reason']
    .map((field) => extractObjectLikeField(trimmed, field))
    .find((value) => Boolean(value));
  const diff = extractObjectLikeField(trimmed, 'diff');
  const status = extractObjectLikeField(trimmed, 'status');
  const tool = extractObjectLikeField(trimmed, 'tool') ?? extractObjectLikeField(trimmed, 'name');
  const url = extractObjectLikeField(trimmed, 'url');
  const description = extractObjectLikeField(trimmed, 'description');
  const query = extractObjectLikeField(trimmed, 'query');

  if (error && message) {
    const prefix = tool ? `${normalizePreviewLine(stripStructuredPreviewNoise(tool), 18)}失败：` : '失败：';
    return `${prefix}${normalizePreviewLine(stripStructuredPreviewNoise(message), 40)}`;
  }
  if (error) {
    const prefix = tool ? `${normalizePreviewLine(stripStructuredPreviewNoise(tool), 18)}失败：` : '失败：';
    return `${prefix}${normalizePreviewLine(stripStructuredPreviewNoise(error), 40)}`;
  }
  if (diff) {
    return `变更：${normalizePreviewLine(stripStructuredPreviewNoise(diff), 40)}`;
  }
  if (url) {
    return `目标：${normalizePreviewLine(stripStructuredPreviewNoise(url), 44)}`;
  }
  if (query) {
    return `查询：${normalizePreviewLine(stripStructuredPreviewNoise(query), 40)}`;
  }
  if (description) {
    return normalizePreviewLine(stripStructuredPreviewNoise(description), 44);
  }
  if (message) {
    return normalizePreviewLine(stripStructuredPreviewNoise(message), 40);
  }
  if (status) {
    return tool
      ? `${normalizePreviewLine(stripStructuredPreviewNoise(tool), 18)} · 状态 ${normalizePreviewLine(stripStructuredPreviewNoise(status), 18)}`
      : `状态：${normalizePreviewLine(stripStructuredPreviewNoise(status), 24)}`;
  }
  return undefined;
}

export function buildSemanticTextPreview(value: string): string {
  const compact = value.trim();
  if (!compact) {
    return '';
  }

  const objectLikePreview = buildObjectLikePreview(compact);
  if (objectLikePreview) {
    return objectLikePreview;
  }

  const firstLine = stripStructuredPreviewNoise(compact.split(/\r?\n/)[0] ?? '');
  if (firstLine) {
    return normalizePreviewLine(firstLine, 48);
  }

  return normalizePreviewLine(compact, 48);
}

export function buildToolResultPreviewText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return buildSemanticTextPreview(trimmed);
}
