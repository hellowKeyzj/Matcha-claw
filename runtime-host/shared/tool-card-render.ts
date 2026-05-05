import type {
  SessionRenderToolStatus,
  SessionRenderToolCard,
  SessionRenderToolResult,
  SessionRenderToolPreview,
  SessionRenderToolUse,
} from './session-adapter-types';
import { resolveToolDisplaySummary } from './tool-display';

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

interface ToolCardContentBlockLike {
  type?: unknown;
  id?: unknown;
  toolCallId?: unknown;
  tool_call_id?: unknown;
  callId?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  content?: unknown;
  text?: unknown;
  isError?: unknown;
  is_error?: unknown;
}

interface ToolResultTextBlockLike {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

function normalizePreviewLine(value: string, maxChars = 48): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function previewText(value: string, maxChars = 48): string {
  return normalizePreviewLine(value, maxChars);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function buildCanvasPreviewSummary(preview: SessionRenderToolPreview | undefined): string {
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

function buildSemanticTextPreview(value: string): string {
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

export function resolveToolCardRenderState(input: {
  name: string;
  input: unknown;
  output?: unknown;
  outputText?: string;
}): Pick<SessionRenderToolCard, 'displayTitle' | 'displayDetail' | 'inputText' | 'result'> {
  const display = resolveToolDisplaySummary({
    name: input.name,
    args: input.input,
  });
  const inputText = serializeToolPayload(input.input);
  const fallbackDisplayDetail = !display.detail && inputText
    ? buildSemanticTextPreview(inputText)
    : undefined;
  const normalizedOutputText = normalizeOptionalString(input.outputText)
    ?? serializeToolPayload(input.output);
  const preview = extractCanvasToolPreview(input.output ?? normalizedOutputText, input.name);
  const jsonOutput = preview ? null : detectJsonText(normalizedOutputText);
  const collapsedPreview = normalizedOutputText
    ? buildToolResultPreviewText(normalizedOutputText)
    : '';
  const result: SessionRenderToolResult = preview
    ? {
        kind: 'canvas',
        surface: 'assistant-bubble',
        collapsedPreview: buildCanvasPreviewSummary(preview),
        preview,
        ...(normalizedOutputText ? { rawText: normalizedOutputText } : {}),
      }
    : jsonOutput
      ? {
          kind: 'json',
          surface: 'tool-card',
          collapsedPreview: jsonOutput.summary,
          bodyText: jsonOutput.pretty,
        }
      : normalizedOutputText
        ? {
            kind: 'text',
            surface: 'tool-card',
            collapsedPreview,
            bodyText: normalizedOutputText,
          }
        : {
          kind: 'none',
          surface: 'tool-card',
        };

  return {
    displayTitle: display.title,
    ...((display.detail ?? fallbackDisplayDetail) ? { displayDetail: display.detail ?? fallbackDisplayDetail } : {}),
    ...(inputText ? { inputText } : {}),
    result,
  };
}

function buildToolResultPreviewText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return buildSemanticTextPreview(trimmed);
}

function normalizeToolIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function findToolCardIndexByCallId(
  tools: ReadonlyArray<SessionRenderToolCard>,
  toolCallId: string,
): number {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (normalizeToolIdentity(tools[index]?.toolCallId) === toolCallId) {
      return index;
    }
  }
  return -1;
}

function findToolCardIndexById(
  tools: ReadonlyArray<SessionRenderToolCard>,
  id: string,
): number {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (normalizeToolIdentity(tools[index]?.id) === id) {
      return index;
    }
  }
  return -1;
}

function findPendingToolCardIndexByName(
  tools: ReadonlyArray<SessionRenderToolCard>,
  name: string,
): number {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (!tool || normalizeToolIdentity(tool.toolCallId)) {
      continue;
    }
    if (tool.name === name) {
      return index;
    }
  }
  return -1;
}

function resolveToolCardId(
  tools: ReadonlyArray<SessionRenderToolCard>,
  preferredId: string,
  fallbackName: string,
): string {
  const baseId = preferredId || fallbackName || 'tool';
  if (!tools.some((tool) => tool.id === baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (tools.some((tool) => tool.id === `${baseId}:${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}:${suffix}`;
}

function normalizeContentBlocks(content: unknown): ToolCardContentBlockLike[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((item): item is ToolCardContentBlockLike => Boolean(item) && typeof item === 'object');
}

function coerceToolArgs(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolResultOutput(block: ToolCardContentBlockLike): unknown {
  if (Object.prototype.hasOwnProperty.call(block, 'result')) {
    return block.result;
  }
  if (Object.prototype.hasOwnProperty.call(block, 'partialResult')) {
    return block.partialResult;
  }
  if (Object.prototype.hasOwnProperty.call(block, 'content')) {
    return block.content;
  }
  return block.text;
}

function extractToolResultOutputText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((item): item is ToolResultTextBlockLike => isRecord(item))
      .flatMap((item) => {
        if (typeof item.text === 'string') {
          return [item.text];
        }
        if (typeof item.content === 'string') {
          return [item.content];
        }
        return [];
      })
      .map((text) => text.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.text === 'string') {
    return value.text;
  }
  if (typeof value.content === 'string') {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return extractToolResultOutputText(value.content);
  }
  return undefined;
}

function findLatestUnresolvedToolCardIndex(
  tools: ReadonlyArray<SessionRenderToolCard>,
  preferredToolCallId: string,
  name: string,
): number {
  if (preferredToolCallId) {
    const exactIndex = findToolCardIndexByCallId(tools, preferredToolCallId);
    if (exactIndex >= 0) {
      return exactIndex;
    }
  }
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (!tool || tool.name !== name || tool.result.kind !== 'none') {
      continue;
    }
    return index;
  }
  return -1;
}

export function buildToolCardsFromMessage(input: {
  content: unknown;
  role?: string;
  toolName?: string;
  toolCallId?: string;
  toolStatuses?: ReadonlyArray<SessionRenderToolStatus>;
  toolCalls?: ReadonlyArray<Record<string, unknown>>;
}): SessionRenderToolCard[] {
  const cards: SessionRenderToolCard[] = [];
  const contentBlocks = normalizeContentBlocks(input.content);

  for (const [index, block] of contentBlocks.entries()) {
    const type = normalizeToolIdentity(block.type).toLowerCase();
    const toolCallId = normalizeToolIdentity(
      block.id
      ?? block.toolCallId
      ?? block.tool_call_id
      ?? block.callId,
    );
    const fallbackName = normalizeOptionalString(input.toolName) ?? 'tool';
    const name = normalizeOptionalString(block.name) ?? fallbackName;
    const isToolCall = (
      type === 'toolcall'
      || type === 'tool_call'
      || type === 'tooluse'
      || type === 'tool_use'
      || (Boolean(name) && (
        Object.prototype.hasOwnProperty.call(block, 'input')
        || Object.prototype.hasOwnProperty.call(block, 'arguments')
        || Object.prototype.hasOwnProperty.call(block, 'args')
      ))
    );

    if (isToolCall && name) {
      const toolInput = coerceToolArgs(block.input ?? block.arguments ?? block.args);
      cards.push({
        id: resolveToolCardId(cards, toolCallId, name || `tool:${index}`),
        ...(toolCallId ? { toolCallId } : {}),
        name,
        input: toolInput,
        status: 'running',
        ...resolveToolCardRenderState({
          name,
          input: toolInput,
        }),
      });
      continue;
    }

    if ((type === 'toolresult' || type === 'tool_result') && name) {
      const output = extractToolResultOutput(block);
      const outputText = extractToolResultOutputText(output) ?? serializeToolPayload(output);
      const isError = block.isError === true || block.is_error === true;
      const existingIndex = findLatestUnresolvedToolCardIndex(cards, toolCallId, name);
      if (existingIndex < 0) {
        cards.push({
          id: resolveToolCardId(cards, toolCallId, name || `tool:${index}`),
          ...(toolCallId ? { toolCallId } : {}),
          name,
          input: null,
          status: isError ? 'error' : 'completed',
          ...resolveToolCardRenderState({
            name,
            input: null,
            output,
            outputText,
          }),
          ...(output !== undefined ? { output } : {}),
        });
        continue;
      }
      const existing = cards[existingIndex]!;
      cards[existingIndex] = {
        ...existing,
        id: toolCallId || existing.id,
        toolCallId: toolCallId || existing.toolCallId,
        name,
        status: isError ? 'error' : 'completed',
        ...resolveToolCardRenderState({
          name,
          input: existing.input,
          output,
          outputText,
        }),
        ...(output !== undefined ? { output } : {}),
      };
    }
  }

  const fallbackToolStatuses = input.toolStatuses ?? [];
  if (cards.length > 0) {
    if (fallbackToolStatuses.length === 0) {
      return cards;
    }
    const safeFallbackToolStatuses = fallbackToolStatuses.filter((toolStatus) => {
      if (normalizeToolIdentity(toolStatus.toolCallId || toolStatus.id)) {
        return true;
      }
      let sameNameCount = 0;
      for (const card of cards) {
        if (card.name === toolStatus.name) {
          sameNameCount += 1;
          if (sameNameCount > 1) {
            return false;
          }
        }
      }
      return true;
    });
    return mergeToolCards({
      existingTools: cards,
      toolUses: [],
      toolStatuses: safeFallbackToolStatuses,
    });
  }

  const toolUses = Array.isArray(input.toolCalls)
    ? input.toolCalls.flatMap((item) => {
        const toolCallId = normalizeToolIdentity(item.id);
        const fn = isRecord(item.function) ? item.function : item;
        const name = normalizeOptionalString(fn.name) ?? '';
        if (!name) {
          return [];
        }
        return [{
          id: toolCallId || name,
          ...(toolCallId ? { toolCallId } : {}),
          name,
          input: coerceToolArgs(fn.input ?? fn.arguments),
        }];
      })
    : [];

  if (toolUses.length > 0 || fallbackToolStatuses.length > 0) {
    return mergeToolCards({
      existingTools: [],
      toolUses,
      toolStatuses: fallbackToolStatuses,
    });
  }

  const standaloneToolName = normalizeOptionalString(input.toolName);
  const standaloneToolCallId = normalizeOptionalString(input.toolCallId);
  const standaloneOutputText = extractToolResultOutputText(input.content) ?? serializeToolPayload(input.content);
  if (
    standaloneToolName
    && standaloneOutputText
    && (normalizeToolIdentity(input.role).toLowerCase() === 'toolresult'
      || normalizeToolIdentity(input.role).toLowerCase() === 'tool_result')
  ) {
    return [{
      id: standaloneToolCallId || standaloneToolName,
      ...(standaloneToolCallId ? { toolCallId: standaloneToolCallId } : {}),
      name: standaloneToolName,
      input: null,
      status: 'completed',
      ...resolveToolCardRenderState({
        name: standaloneToolName,
        input: null,
        output: input.content,
        outputText: standaloneOutputText,
      }),
      output: input.content,
    }];
  }

  return [];
}

export function mergeToolCards(input: {
  existingTools: ReadonlyArray<SessionRenderToolCard>;
  toolUses: ReadonlyArray<SessionRenderToolUse>;
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>;
}): SessionRenderToolCard[] {
  const merged = input.existingTools.map((tool) => ({ ...tool }));

  for (const toolUse of input.toolUses) {
    const toolCallId = normalizeToolIdentity(toolUse.toolCallId);
    const existingIndex = toolCallId
      ? Math.max(
          findToolCardIndexByCallId(merged, toolCallId),
          findPendingToolCardIndexByName(merged, toolUse.name),
        )
      : findToolCardIndexById(merged, normalizeToolIdentity(toolUse.id));
    if (existingIndex < 0) {
      merged.push({
        id: resolveToolCardId(merged, toolCallId || normalizeToolIdentity(toolUse.id), toolUse.name),
        ...(toolCallId ? { toolCallId } : {}),
        name: toolUse.name,
        input: structuredClone(toolUse.input),
        status: toolUse.status ?? 'running',
        ...resolveToolCardRenderState({
          name: toolUse.name,
          input: toolUse.input,
        }),
        ...(toolUse.summary ? { summary: toolUse.summary } : {}),
        ...(toolUse.durationMs != null ? { durationMs: toolUse.durationMs } : {}),
      });
      continue;
    }
    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      id: toolCallId || existing.id,
      toolCallId: toolCallId || existing.toolCallId,
      name: toolUse.name || existing.name,
      input: structuredClone(toolUse.input),
      status: toolUse.status ?? existing.status,
      ...resolveToolCardRenderState({
        name: toolUse.name || existing.name,
        input: toolUse.input,
        output: existing.output,
        outputText: existing.result.kind === 'canvas'
          ? existing.result.rawText
          : existing.result.kind === 'text' || existing.result.kind === 'json'
            ? serializeToolResultBodyText(existing.result)
            : undefined,
      }),
      summary: toolUse.summary ?? existing.summary,
      durationMs: toolUse.durationMs ?? existing.durationMs,
      updatedAt: existing.updatedAt,
      output: existing.output,
    };
  }

  for (const toolStatus of input.toolStatuses) {
    const toolCallId = normalizeToolIdentity(toolStatus.toolCallId || toolStatus.id);
    const existingIndex = toolCallId
      ? Math.max(
          findToolCardIndexByCallId(merged, toolCallId),
          findPendingToolCardIndexByName(merged, toolStatus.name),
        )
      : Math.max(
          findToolCardIndexById(merged, normalizeToolIdentity(toolStatus.id ?? '')),
          findPendingToolCardIndexByName(merged, toolStatus.name),
        );
    if (existingIndex < 0) {
      merged.push({
        id: resolveToolCardId(merged, toolCallId || normalizeToolIdentity(toolStatus.id), toolStatus.name),
        ...(toolCallId ? { toolCallId } : {}),
        name: toolStatus.name,
        input: null,
        status: toolStatus.status,
        ...resolveToolCardRenderState({
          name: toolStatus.name,
          input: null,
          output: toolStatus.output,
          outputText: toolStatus.outputText,
        }),
        ...(toolStatus.summary ? { summary: toolStatus.summary } : {}),
        ...(toolStatus.durationMs != null ? { durationMs: toolStatus.durationMs } : {}),
        ...(toolStatus.updatedAt != null ? { updatedAt: toolStatus.updatedAt } : {}),
        ...(toolStatus.output !== undefined ? { output: structuredClone(toolStatus.output) } : {}),
      });
      continue;
    }
    const existing = merged[existingIndex]!;
    const nextName = (
      (toolStatus.name === toolStatus.toolCallId || toolStatus.name === toolStatus.id)
      && existing.name
    ) ? existing.name : (toolStatus.name || existing.name);
    const nextOutput = toolStatus.output !== undefined ? structuredClone(toolStatus.output) : existing.output;
    const nextRawOutputText = toolStatus.outputText
      ?? (existing.result.kind === 'canvas'
        ? existing.result.rawText
        : existing.result.kind === 'text' || existing.result.kind === 'json'
          ? serializeToolResultBodyText(existing.result)
          : undefined);
    merged[existingIndex] = {
      ...existing,
      id: toolCallId || existing.id,
      toolCallId: toolCallId || existing.toolCallId,
      name: nextName,
      status: toolStatus.status,
      ...resolveToolCardRenderState({
        name: nextName,
        input: existing.input,
        output: nextOutput,
        outputText: nextRawOutputText,
      }),
      summary: toolStatus.summary ?? existing.summary,
      durationMs: toolStatus.durationMs ?? existing.durationMs,
      updatedAt: toolStatus.updatedAt ?? existing.updatedAt,
      output: nextOutput,
    };
  }

  return merged;
}

function serializeToolResultBodyText(result: SessionRenderToolResult): string | undefined {
  if (result.kind === 'none' || result.kind === 'canvas') {
    return undefined;
  }
  return result.bodyText;
}
