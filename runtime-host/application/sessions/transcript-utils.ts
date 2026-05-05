import {
  extractMessageText,
  normalizeAssistantFinalText as normalizeAssistantFinalTextShared,
  normalizeMessageRole,
  normalizeOptionalString,
  normalizeRawChatMessage,
  sanitizeAssistantDisplayText,
  sanitizeCanonicalUserText,
} from '../../shared/chat-message-normalization';
import { buildToolCardsFromMessage, mergeToolCards } from '../../shared/tool-card-render';
import {
  buildAssistantSegmentsFromMessageContent,
  buildAssistantSegmentsFromToolCards,
} from './assistant-turn-segments';
import type {
  SessionCatalogTitleSource,
  SessionTimelineEntryStatus,
  SessionTaskCompletionEvent,
  SessionTimelineEntry,
  SessionTurnBindingConfidence,
  SessionTurnBindingSource,
  SessionTurnIdentityConfidence,
  SessionTurnIdentityMode,
  SessionTimelineMessageEntry,
  SessionTimelineTaskCompletionEntry,
  SessionTimelineToolActivityEntry,
} from '../../shared/session-adapter-types';
import { normalizeTaskCompletionEvents } from './task-completion-events';

const SESSION_LABEL_MAX_LENGTH = 50;
const ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS: RegExp[] = [
  /^a new session was started via\b/i,
  /^##\s*task manager\b/i,
  /^task manager.*(恢复提示|动态切换建议)/i,
  /^检测到多个待确认任务/i,
];

export interface SessionTranscriptMessage {
  role: 'user' | 'assistant' | 'system' | 'toolresult' | 'tool_result';
  content: unknown;
  timestamp?: number;
  id?: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  status?: 'sending' | 'sent' | 'timeout' | 'error';
  streaming?: boolean;
  agentId?: string;
  toolCallId?: string;
  tool_calls?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  toolName?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  details?: unknown;
  toolStatuses?: Array<Record<string, unknown>>;
  taskCompletionEvents?: SessionTaskCompletionEvent[];
  _attachedFiles?: Array<Record<string, unknown>>;
  isError?: boolean;
}

interface TranscriptMessageShape {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  id?: unknown;
  messageId?: unknown;
  message_id?: unknown;
  originMessageId?: unknown;
  origin_message_id?: unknown;
  clientId?: unknown;
  client_id?: unknown;
  idempotencyKey?: unknown;
  idempotency_key?: unknown;
  agentId?: unknown;
  agent_id?: unknown;
  parentMessageId?: unknown;
  parent_message_id?: unknown;
  toolCallId?: unknown;
  tool_call_id?: unknown;
  toolName?: unknown;
  tool_name?: unknown;
  name?: unknown;
  details?: unknown;
  isError?: unknown;
  is_error?: unknown;
}

interface TranscriptLineShape {
  id?: unknown;
  timestamp?: unknown;
  message?: TranscriptMessageShape;
}

interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  data?: unknown;
  mimeType?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
    const asDate = Date.parse(value);
    if (Number.isFinite(asDate)) {
      return asDate;
    }
  }
  return undefined;
}

function cleanGatewayUserText(text: string): string {
  return sanitizeCanonicalUserText(text);
}

function normalizeSessionLabelText(text: string): string {
  const cleaned = text
    .replace(/\[media attached:[^\]]+\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '(file attached)') {
    return '';
  }
  if (cleaned.length <= SESSION_LABEL_MAX_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, SESSION_LABEL_MAX_LENGTH)}...`;
}

function normalizeAssistantFinalText(content: unknown): string {
  return normalizeAssistantFinalTextShared(content);
}

function resolveUserLabelCandidate(content: unknown): string {
  return normalizeSessionLabelText(cleanGatewayUserText(extractMessageText(content)));
}

function resolveAssistantLabelCandidate(content: unknown): string {
  return normalizeSessionLabelText(normalizeAssistantFinalText(content));
}

export interface SessionResolvedLabel {
  label: string | null;
  titleSource: SessionCatalogTitleSource;
}

function shouldIgnoreAssistantSessionLabel(text: string): boolean {
  if (!text) {
    return true;
  }
  return ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

export function resolveSessionLaneKey(agentId: string): string {
  return agentId ? `member:${agentId}` : 'main';
}

interface ResolvedTurnBinding {
  key: string;
  source: SessionTurnBindingSource;
  mode: SessionTurnIdentityMode;
  confidence: SessionTurnIdentityConfidence;
}

function resolveTurnBinding(
  message: SessionTranscriptMessage,
  options: {
    runId?: string;
  } = {},
): ResolvedTurnBinding | null {
  const runId = normalizeOptionalString(options.runId);
  if (runId) {
    return {
      key: runId,
      source: 'run',
      mode: 'run',
      confidence: 'strong',
    };
  }

  const messageId = normalizeOptionalString(message.messageId);
  if (messageId) {
    return {
      key: messageId,
      source: 'message',
      mode: 'message',
      confidence: 'strong',
    };
  }

  const originMessageId = normalizeOptionalString(message.originMessageId);
  if (originMessageId) {
    return {
      key: originMessageId,
      source: 'origin',
      mode: 'origin',
      confidence: 'fallback',
    };
  }

  const clientId = normalizeOptionalString(message.clientId);
  if (clientId) {
    return {
      key: clientId,
      source: 'client',
      mode: 'client',
      confidence: 'fallback',
    };
  }

  return null;
}

function resolveEntryId(
  message: SessionTranscriptMessage,
  index: number,
  options: {
    runId?: string;
    sequenceId?: number;
  } = {},
): string {
  return normalizeOptionalString(
    message.id
    ?? message.messageId
    ?? message.originMessageId
    ?? message.clientId,
  ) ?? (() => {
    const runId = normalizeOptionalString(options.runId);
    if (runId) {
      const agentId = normalizeOptionalString(message.agentId);
      return agentId
        ? `run:${runId}:agent:${agentId}:${message.role || 'message'}:${index}`
        : `run:${runId}:${message.role || 'message'}:${index}`;
    }
    return `entry-${index}`;
  })();
}

function readMessageContent(message: SessionTranscriptMessage): unknown {
  return message.content;
}

function resolveDisplayText(message: SessionTranscriptMessage): string {
  if (message.role === 'user') {
    return sanitizeCanonicalUserText(extractMessageText(message.content));
  }
  if (message.role === 'assistant') {
    return sanitizeAssistantDisplayText(message.content);
  }
  return extractMessageText(message.content).trim();
}

function extractThinking(message: SessionTranscriptMessage): string | null {
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type !== 'thinking' || typeof block.thinking !== 'string') {
      continue;
    }
    const cleaned = block.thinking.trim();
    if (cleaned) {
      parts.push(cleaned);
    }
  }
  const combined = parts.join('\n\n').trim();
  return combined || null;
}

function extractImages(message: SessionTranscriptMessage): SessionTimelineMessageEntry['images'] {
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return [];
  }
  const images: SessionTimelineMessageEntry['images'] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type !== 'image') {
      continue;
    }
    if (block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
      images.push({
        mimeType: block.source.media_type,
        data: block.source.data,
      });
      continue;
    }
    if (block.source?.type === 'url' && typeof block.source.url === 'string') {
      images.push({
        mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/jpeg',
        url: block.source.url,
      });
      continue;
    }
    if (typeof block.data === 'string') {
      images.push({
        mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg',
        data: block.data,
      });
    }
  }
  return images;
}

function extractToolUses(message: SessionTranscriptMessage): SessionTimelineMessageEntry['toolUses'] {
  const content = readMessageContent(message);
  const tools: SessionTimelineMessageEntry['toolUses'] = [];
  if (Array.isArray(content)) {
    for (const block of content as ContentBlockLike[]) {
      const type = typeof block.type === 'string' ? block.type : '';
      const name = typeof block.name === 'string' ? block.name.trim() : '';
      if (!name || (type !== 'tool_use' && type !== 'toolCall')) {
        continue;
      }
      const toolCallId = typeof block.id === 'string' && block.id.trim() ? block.id.trim() : undefined;
      tools.push({
        id: toolCallId || name,
        ...(toolCallId ? { toolCallId } : {}),
        name,
        input: block.input ?? block.arguments,
      });
    }
  }
  if (tools.length > 0) {
    return tools;
  }
  const toolCalls = message.tool_calls ?? message.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const row = item as Record<string, unknown>;
    const toolCallId = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : '';
    const fn = (row.function ?? row) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) {
      return [];
    }
    let input: unknown = fn.input ?? fn.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        // keep raw string
      }
    }
    return [{
      id: toolCallId || name,
      ...(toolCallId ? { toolCallId } : {}),
      name,
      input,
    }];
  });
}

function readAttachedFiles(message: SessionTranscriptMessage): SessionTimelineMessageEntry['attachedFiles'] {
  const attachedFiles = message._attachedFiles;
  if (!Array.isArray(attachedFiles)) {
    return [];
  }
  return attachedFiles.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const row = item as Record<string, unknown>;
    const fileName = typeof row.fileName === 'string' ? row.fileName : 'file';
    const mimeType = typeof row.mimeType === 'string' ? row.mimeType : 'application/octet-stream';
    const fileSize = typeof row.fileSize === 'number' && Number.isFinite(row.fileSize) ? row.fileSize : 0;
    const preview = typeof row.preview === 'string' ? row.preview : null;
    const filePath = typeof row.filePath === 'string' && row.filePath.trim() ? row.filePath : undefined;
    return [{
      fileName,
      mimeType,
      fileSize,
      preview,
      ...(filePath ? { filePath } : {}),
    }];
  });
}

function normalizeToolOutputText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const extracted = extractMessageText(value).trim();
    if (extracted) {
      return extracted;
    }
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function mergeToolStatusRecords(
  existingStatuses: SessionTimelineMessageEntry['toolStatuses'],
  incomingStatuses: SessionTimelineMessageEntry['toolStatuses'],
): SessionTimelineMessageEntry['toolStatuses'] {
  const merged = existingStatuses.map((status) => ({ ...status }));
  for (const incoming of incomingStatuses) {
    const key = incoming.toolCallId || incoming.id || incoming.name;
    if (!key) {
      merged.push({ ...incoming });
      continue;
    }
    const existingIndex = merged.findIndex((status) => (
      status.toolCallId === key
      || status.id === key
      || (
        !status.toolCallId
        && !status.id
        && status.name === incoming.name
      )
    ));
    if (existingIndex < 0) {
      merged.push({ ...incoming });
      continue;
    }
    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      ...incoming,
      name: (
        (incoming.name === incoming.toolCallId || incoming.name === incoming.id)
        && existing.name
      ) ? existing.name : incoming.name,
    };
  }
  return merged;
}

function resolveFallbackToolName(input: {
  message: SessionTranscriptMessage;
  toolCallId?: string;
  id?: string;
}): string {
  const explicitName = normalizeOptionalString(input.message.toolName ?? input.message.name);
  if (explicitName) {
    return explicitName;
  }
  const toolCallId = normalizeOptionalString(input.toolCallId) ?? '';
  if (!toolCallId) {
    return normalizeOptionalString(input.id) ?? '';
  }
  const contentToolName = extractToolUses(input.message).find((toolUse) => (
    toolUse.toolCallId === toolCallId || toolUse.id === toolCallId
  ))?.name;
  if (contentToolName) {
    return contentToolName;
  }
  return normalizeOptionalString(input.id) ?? '';
}

function readToolStatusesFromStatusRecords(
  message: SessionTranscriptMessage,
  records: ReadonlyArray<Record<string, unknown>>,
): SessionTimelineMessageEntry['toolStatuses'] {
  return records.flatMap((item) => {
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
    const toolCallId = typeof item.toolCallId === 'string' && item.toolCallId.trim() ? item.toolCallId.trim() : undefined;
    const fallbackName = resolveFallbackToolName({
      message,
      toolCallId,
      id,
    });
    const name = typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : fallbackName;
    const status = item.status === 'running' || item.status === 'completed' || item.status === 'error'
      ? item.status
      : null;
    if (!name || !status) {
      return [];
    }
    const summary = typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : undefined;
    const durationMs = typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) ? item.durationMs : undefined;
    const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : undefined;
    const output = Object.prototype.hasOwnProperty.call(item, 'result')
      ? item.result
      : (Object.prototype.hasOwnProperty.call(item, 'partialResult') ? item.partialResult : undefined);
    const outputText = normalizeToolOutputText(output);
    return [{
      ...(id ? { id } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      name,
      status,
      ...(summary ? { summary } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      ...(updatedAt != null ? { updatedAt } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(outputText ? { outputText } : {}),
    }];
  });
}

function readToolStatusesFromContent(message: SessionTranscriptMessage): SessionTimelineMessageEntry['toolStatuses'] {
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') {
      return [];
    }
    const row = block as Record<string, unknown>;
    const type = typeof row.type === 'string' ? row.type : '';
    if (type !== 'tool_result' && type !== 'toolResult') {
      return [];
    }
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined;
    const toolCallId = typeof row.toolCallId === 'string' && row.toolCallId.trim()
      ? row.toolCallId.trim()
      : id;
    const fallbackName = resolveFallbackToolName({
      message,
      toolCallId,
      id,
    });
    const name = typeof row.name === 'string' && row.name.trim()
      ? row.name.trim()
      : fallbackName;
    if (!name) {
      return [];
    }
    const output = Object.prototype.hasOwnProperty.call(row, 'result')
      ? row.result
      : (
          Object.prototype.hasOwnProperty.call(row, 'partialResult')
            ? row.partialResult
            : (Object.prototype.hasOwnProperty.call(row, 'content') ? row.content : row.text)
        );
    const outputText = normalizeToolOutputText(output);
    const isError = row.isError === true || row.is_error === true;
    return [{
      ...(id ? { id } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      name,
      status: isError ? 'error' : 'completed',
      ...(output !== undefined ? { output } : {}),
      ...(outputText ? { outputText } : {}),
    }];
  });
}

function readToolStatuses(message: SessionTranscriptMessage): SessionTimelineMessageEntry['toolStatuses'] {
  const records = Array.isArray(message.toolStatuses)
    ? message.toolStatuses.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
  const mergedStatuses = mergeToolStatusRecords(
    readToolStatusesFromStatusRecords(message, records),
    readToolStatusesFromContent(message),
  );
  if (mergedStatuses.length > 0) {
    return mergedStatuses;
  }
  if (message.role !== 'toolresult' && message.role !== 'tool_result') {
    return mergedStatuses;
  }
  const toolCallId = normalizeOptionalString(message.toolCallId);
  const name = resolveFallbackToolName({
    message,
    toolCallId,
  });
  if (!name) {
      return mergedStatuses;
  }
  const output = message.details !== undefined
    ? message.details
    : message.content;
  const outputText = normalizeToolOutputText(output);
  return [{
    ...(toolCallId ? { id: toolCallId, toolCallId } : {}),
    name,
    status: message.isError ? 'error' : 'completed',
    ...(output !== undefined ? { output } : {}),
    ...(outputText ? { outputText } : {}),
  }];
}

function readMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
  }
  return refs;
}

function extractImagesAsAttachedFiles(content: unknown): SessionTimelineMessageEntry['attachedFiles'] {
  if (!Array.isArray(content)) {
    return [];
  }
  const files: SessionTimelineMessageEntry['attachedFiles'] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type === 'image') {
      if (block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
        files.push({
          fileName: 'image',
          mimeType: block.source.media_type,
          fileSize: 0,
          preview: `data:${block.source.media_type};base64,${block.source.data}`,
        });
      } else if (block.source?.type === 'url' && typeof block.source.url === 'string') {
        files.push({
          fileName: 'image',
          mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/jpeg',
          fileSize: 0,
          preview: block.source.url,
        });
      } else if (typeof block.data === 'string') {
        const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg';
        files.push({
          fileName: 'image',
          mimeType,
          fileSize: 0,
          preview: `data:${mimeType};base64,${block.data}`,
        });
      }
    }
    if ((block.type === 'tool_result' || block.type === 'toolResult') && block.content !== undefined) {
      files.push(...extractImagesAsAttachedFiles(block.content));
    }
  }
  return files;
}

function mergeAttachedFiles(
  existingFiles: ReadonlyArray<SessionTimelineMessageEntry['attachedFiles'][number]>,
  incomingFiles: ReadonlyArray<SessionTimelineMessageEntry['attachedFiles'][number]>,
): SessionTimelineMessageEntry['attachedFiles'] {
  const merged = existingFiles.map((file) => ({ ...file }));
  for (const file of incomingFiles) {
    const exists = merged.some((candidate) => (
      candidate.fileName === file.fileName
      && candidate.mimeType === file.mimeType
      && candidate.fileSize === file.fileSize
      && (candidate.preview ?? null) === (file.preview ?? null)
      && (candidate.filePath ?? null) === (file.filePath ?? null)
    ));
    if (!exists) {
      merged.push({ ...file });
    }
  }
  return merged;
}

function findLatestAssistantContentRow(
  rows: SessionTimelineEntry[],
  laneKey: string,
  turnKey: string,
): SessionTimelineMessageEntry | SessionTimelineToolActivityEntry | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'assistant') {
      continue;
    }
    if ((row.kind !== 'message' && row.kind !== 'tool-activity') || row.laneKey !== laneKey || row.turnKey !== turnKey) {
      continue;
    }
    return row;
  }
  return null;
}

function findLatestAssistantContentRowByToolCallId(
  rows: SessionTimelineEntry[],
  toolCallId: string,
  preferredLaneKey?: string,
): SessionTimelineMessageEntry | SessionTimelineToolActivityEntry | null {
  const matchesToolCallId = (row: SessionTimelineMessageEntry | SessionTimelineToolActivityEntry) => (
    row.toolUses.some((toolUse) => toolUse.toolCallId === toolCallId || toolUse.id === toolCallId)
    || row.toolStatuses.some((toolStatus) => toolStatus.toolCallId === toolCallId || toolStatus.id === toolCallId)
    || row.toolCards.some((toolCard) => toolCard.toolCallId === toolCallId || toolCard.id === toolCallId)
  );

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'assistant' || (row.kind !== 'message' && row.kind !== 'tool-activity')) {
      continue;
    }
    if (preferredLaneKey && row.laneKey !== preferredLaneKey) {
      continue;
    }
    if (matchesToolCallId(row)) {
      return row;
    }
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'assistant' || (row.kind !== 'message' && row.kind !== 'tool-activity')) {
      continue;
    }
    if (matchesToolCallId(row)) {
      return row;
    }
  }

  return null;
}

function findLatestAssistantContentRowByRunId(
  rows: SessionTimelineEntry[],
  runId: string,
  preferredLaneKey?: string,
): SessionTimelineMessageEntry | SessionTimelineToolActivityEntry | null {
  if (!runId) {
    return null;
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'assistant' || (row.kind !== 'message' && row.kind !== 'tool-activity')) {
      continue;
    }
    if (preferredLaneKey && row.laneKey !== preferredLaneKey) {
      continue;
    }
    if (row.runId === runId) {
      return row;
    }
  }

  return null;
}

function materializeToolResultPatchRows(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  sequenceId?: number;
  index: number;
  existingRows: SessionTimelineEntry[];
}): SessionTimelineEntry[] {
  const agentId = normalizeOptionalString(input.message.agentId) ?? '';
  const laneKey = resolveSessionLaneKey(agentId);
  const entryId = resolveEntryId(input.message, input.index, {
    sequenceId: input.sequenceId,
  });
  return materializeToolResultRows({
    sessionKey: input.sessionKey,
    message: input.message,
    status: resolveTranscriptEntryStatus(input.message),
    sequenceId: input.sequenceId,
    createdAt: input.message.timestamp,
    entryId,
    laneKey,
    turnKey: `${laneKey}:entry:${entryId}`,
    agentId,
    text: resolveDisplayText(input.message),
    existingRows: input.existingRows,
  });
}

function materializeToolResultRows(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  status: SessionTimelineEntryStatus;
  runId?: string;
  sequenceId?: number;
  createdAt?: number;
  entryId: string;
  laneKey: string;
  turnKey: string;
  agentId: string;
  text: string;
  existingRows: SessionTimelineEntry[];
}): SessionTimelineEntry[] {
  const attachedFiles = mergeAttachedFiles(
    readAttachedFiles(input.message),
    [
      ...extractImagesAsAttachedFiles(input.message.content),
      ...readMediaRefs(input.text).map((ref) => ({
        fileName: ref.filePath.split(/[\\/]/).pop() || 'file',
        mimeType: ref.mimeType,
        fileSize: 0,
        preview: null,
        filePath: ref.filePath,
      })),
    ],
  );
  const toolStatuses = readToolStatuses(input.message);
  const toolCallId = normalizeOptionalString(
    input.message.toolCallId
    ?? toolStatuses[0]?.toolCallId
    ?? toolStatuses[0]?.id,
  );
  const existingAssistantRow = toolCallId
    ? (
        findLatestAssistantContentRowByToolCallId(input.existingRows, toolCallId, input.laneKey)
        ?? findLatestAssistantContentRow(input.existingRows, input.laneKey, input.turnKey)
      )
    : findLatestAssistantContentRow(input.existingRows, input.laneKey, input.turnKey);
  const resolvedLaneKey = existingAssistantRow?.laneKey ?? input.laneKey;
  const resolvedTurnKey = existingAssistantRow?.turnKey ?? input.turnKey;
  const resolvedTurnBindingSource = existingAssistantRow?.turnBindingSource
    ?? (toolCallId ? 'tool_call' : 'heuristic');
  const resolvedTurnBindingConfidence = existingAssistantRow?.turnBindingConfidence
    ?? (toolCallId ? 'strong' : 'fallback');
  const resolvedTurnIdentityMode = existingAssistantRow?.turnIdentityMode
    ?? (toolCallId ? 'tool_call' : 'heuristic');
  const resolvedTurnIdentityConfidence = existingAssistantRow?.turnIdentityConfidence
    ?? (toolCallId ? 'strong' : 'fallback');
  const resolvedAgentId = existingAssistantRow?.agentId ?? input.agentId;
  const existingToolUses = existingAssistantRow?.toolUses ?? [];
  const existingToolStatuses = existingAssistantRow?.toolStatuses ?? [];
  const existingToolCards = existingAssistantRow?.toolCards ?? [];
  const nextToolStatuses = mergeToolStatusRecords(existingToolStatuses, toolStatuses);
  const nextToolCards = mergeToolCards({
    existingTools: existingToolCards,
    toolUses: existingToolUses,
    toolStatuses: nextToolStatuses,
  });
  const updatedToolKeys = toolStatuses.map((status) => normalizeOptionalString(status.toolCallId ?? status.id ?? status.name) ?? '').filter(Boolean);
  if (existingAssistantRow?.kind === 'message') {
    return [{
      ...existingAssistantRow,
      key: existingAssistantRow.key,
      status: input.status,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
      createdAt: input.createdAt ?? existingAssistantRow.createdAt,
      turnBindingSource: resolvedTurnBindingSource,
      turnBindingConfidence: resolvedTurnBindingConfidence,
      turnIdentityMode: resolvedTurnIdentityMode,
      turnIdentityConfidence: resolvedTurnIdentityConfidence,
      sourceRole: input.message.role,
      attachedFiles: mergeAttachedFiles(existingAssistantRow.attachedFiles, attachedFiles),
      toolStatuses: nextToolStatuses,
      toolCards: nextToolCards,
      assistantSegments: buildAssistantSegmentsFromToolCards({
        toolCards: nextToolCards,
        updatedToolKeys,
      }),
      isStreaming: input.status === 'streaming' || existingAssistantRow.isStreaming,
    }];
  }
  return [{
    key: existingAssistantRow?.key ?? `session:${input.sessionKey}|tool-activity:${input.entryId}`,
    kind: 'tool-activity',
    sessionKey: input.sessionKey,
    role: 'assistant',
    text: existingAssistantRow?.text ?? '',
    createdAt: input.createdAt,
    status: input.status,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
    entryId: existingAssistantRow?.entryId ?? input.entryId,
    laneKey: resolvedLaneKey,
    turnKey: resolvedTurnKey,
    turnBindingSource: resolvedTurnBindingSource,
    turnBindingConfidence: resolvedTurnBindingConfidence,
    turnIdentityMode: resolvedTurnIdentityMode,
    turnIdentityConfidence: resolvedTurnIdentityConfidence,
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    sourceRole: input.message.role,
    assistantTurnKey: resolvedTurnKey,
    assistantLaneKey: resolvedLaneKey,
    assistantLaneAgentId: resolvedAgentId || null,
    toolUses: existingToolUses,
    toolStatuses: nextToolStatuses,
    toolCards: nextToolCards,
    assistantSegments: buildAssistantSegmentsFromToolCards({
      toolCards: nextToolCards,
      updatedToolKeys,
    }),
    attachedFiles,
    isStreaming: input.status === 'streaming' || Boolean(input.message.streaming),
  }];
}

function buildTaskCompletionText(row: SessionTimelineTaskCompletionEntry): string {
  return [
    row.taskLabel,
    row.statusLabel,
    row.result,
  ].filter((value) => typeof value === 'string' && value.trim()).join(' · ');
}

function resolveCompletionTriggerRow(
  rows: SessionTimelineEntry[],
  fallbackEntryId: string,
): SessionTimelineEntry | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'user') {
      continue;
    }
    if (row.kind === 'task-completion' || row.entryId === fallbackEntryId) {
      continue;
    }
    return row;
  }
  return null;
}

export function resolveTranscriptEntryStatus(message: SessionTranscriptMessage): SessionTimelineEntryStatus {
  if (message.streaming) {
    return 'streaming';
  }
  if (message.isError || message.status === 'error') {
    return 'error';
  }
  if (message.status === 'sending' || message.status === 'timeout') {
    return 'pending';
  }
  return 'final';
}

export function buildTimelineEntriesFromTranscriptMessage(
  sessionKey: string,
  message: SessionTranscriptMessage,
  options: {
    runId?: string;
    sequenceId?: number;
    status?: SessionTimelineEntryStatus;
    index: number;
    existingRows?: SessionTimelineEntry[];
  },
): SessionTimelineEntry[] {
  const agentId = normalizeOptionalString(message.agentId) ?? '';
  const existingRows = options.existingRows ?? [];
  const defaultLaneKey = resolveSessionLaneKey(agentId);
  const turnBinding = resolveTurnBinding(message, {
    runId: options.runId,
  });
  const laneKey = defaultLaneKey;
  const entryId = resolveEntryId(message, options.index, {
    runId: options.runId,
    sequenceId: options.sequenceId,
  });
  const status = options.status ?? 'final';
  const createdAt = message.timestamp;
  const text = resolveDisplayText(message);
  const turnKey = turnBinding
    ? `${laneKey}:${turnBinding.key}`
    : `${laneKey}:entry:${entryId}`;
  const resolvedRunId = options.runId;
  const resolvedAgentId = agentId;

  if (message.role === 'toolresult' || message.role === 'tool_result') {
    return materializeToolResultRows({
      sessionKey,
      message,
      status,
      runId: resolvedRunId,
      sequenceId: options.sequenceId,
      createdAt,
      entryId,
      laneKey,
      turnKey,
      agentId: resolvedAgentId,
      text,
      existingRows,
    });
  }

  const toolUses = extractToolUses(message);
  const toolStatuses = readToolStatuses(message);
  const toolCards = buildToolCardsFromMessage({
    content: message.content,
    role: message.role,
    toolName: message.toolName ?? message.name,
    toolCallId: message.toolCallId,
    toolStatuses,
    toolCalls: message.tool_calls ?? message.toolCalls,
  });
  const thinking = extractThinking(message);
  const images = extractImages(message);
  const attachedFiles = readAttachedFiles(message);
  const role = message.role === 'user' || message.role === 'system' ? message.role : 'assistant';
  const assistantSegments = role === 'assistant'
    ? buildAssistantSegmentsFromMessageContent({
        role: message.role,
        entryKey: `session:${sessionKey}|entry:${entryId}`,
        content: readMessageContent(message),
        text,
        images,
        attachedFiles,
        toolCards,
      })
    : [];
  const base = {
    key: `session:${sessionKey}|entry:${entryId}`,
    sessionKey,
    role,
    text,
    createdAt,
    status,
    ...(resolvedRunId ? { runId: resolvedRunId } : {}),
    ...(options.sequenceId != null ? { sequenceId: options.sequenceId } : {}),
    entryId,
    laneKey,
    turnKey,
    ...(turnBinding ? {
      turnBindingSource: turnBinding.source,
      turnBindingConfidence: turnBinding.confidence,
      turnIdentityMode: turnBinding.mode,
      turnIdentityConfidence: turnBinding.confidence,
    } : {
      turnBindingSource: 'heuristic' as const,
      turnBindingConfidence: 'fallback' as const,
      turnIdentityMode: 'heuristic' as const,
      turnIdentityConfidence: 'fallback' as const,
    }),
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
      ...(role === 'assistant' ? {
        sourceRole: message.role,
        assistantTurnKey: turnKey,
        assistantLaneKey: laneKey,
        assistantLaneAgentId: resolvedAgentId || null,
    } : {}),
  } as const;

  const isToolActivity = (
    role === 'assistant'
    && toolUses.length > 0
    && text.trim().length === 0
    && !thinking
    && images.length === 0
    && attachedFiles.length === 0
  );

  const rows: SessionTimelineEntry[] = [];
  if (isToolActivity) {
    rows.push({
      ...base,
      kind: 'tool-activity',
      role: 'assistant',
      assistantSegments: buildAssistantSegmentsFromToolCards({
        toolCards,
      }),
      toolUses,
      toolStatuses,
      toolCards,
      attachedFiles: [],
      isStreaming: status === 'streaming' || Boolean(message.streaming),
    });
  } else {
    rows.push({
      ...base,
      kind: 'message',
      thinking,
      assistantSegments,
      images,
      toolUses,
      attachedFiles,
      toolStatuses,
      toolCards,
      isStreaming: status === 'streaming' || Boolean(message.streaming),
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
      ...(message.clientId ? { clientId: message.clientId } : {}),
    });
  }

  const completionEvents = Array.isArray(message.taskCompletionEvents) ? message.taskCompletionEvents : [];
  for (const [completionIndex, event] of completionEvents.entries()) {
    const triggerRow = resolveCompletionTriggerRow(existingRows, entryId);
    const completionRow: SessionTimelineTaskCompletionEntry = {
      key: `session:${sessionKey}|completion:${entryId}:${completionIndex}`,
      kind: 'task-completion',
      sessionKey,
      role: 'system',
      text: [
        event.taskLabel,
        event.statusLabel,
        event.result,
      ].filter((value) => typeof value === 'string' && value.trim()).join(' · '),
      createdAt,
      status: 'final',
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.sequenceId != null ? { sequenceId: options.sequenceId } : {}),
      entryId,
      childSessionKey: event.childSessionKey,
      ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
      ...(event.childAgentId ? { childAgentId: event.childAgentId } : {}),
      ...(event.taskLabel ? { taskLabel: event.taskLabel } : {}),
      ...(event.statusLabel ? { statusLabel: event.statusLabel } : {}),
      ...(event.result ? { result: event.result } : {}),
      ...(event.statsLine ? { statsLine: event.statsLine } : {}),
      ...(event.replyInstruction ? { replyInstruction: event.replyInstruction } : {}),
      ...(triggerRow?.key ? { triggerItemKey: triggerRow.key } : {}),
    };
    if (!completionRow.text) {
      completionRow.text = buildTaskCompletionText(completionRow);
    }
    rows.push(completionRow);
  }

  return rows;
}

export function parseTranscriptMessages(content: string): SessionTranscriptMessage[] {
  const lines = content.split(/\r?\n/).filter(Boolean);
  const messages: SessionTranscriptMessage[] = [];

  for (const line of lines) {
    let parsed: TranscriptLineShape;
    try {
      parsed = JSON.parse(line) as TranscriptLineShape;
    } catch {
      continue;
    }
    if (!isRecord(parsed.message)) {
      continue;
    }

    const role = normalizeMessageRole(parsed.message.role);
    if (!role) {
      continue;
    }

    const normalized = normalizeRawChatMessage({
      ...parsed.message,
      role,
      content: Object.prototype.hasOwnProperty.call(parsed.message, 'content')
        ? parsed.message.content
        : '',
      timestamp: normalizeTimestamp(parsed.timestamp ?? parsed.message.timestamp),
      id: normalizeOptionalString(parsed.id ?? parsed.message.id),
    }, {
      fallbackMessageIdToId: false,
      fallbackOriginMessageIdToParentMessageId: true,
    });

    messages.push({
      role,
      content: Object.prototype.hasOwnProperty.call(normalized, 'content')
        ? normalized.content
        : '',
      timestamp: normalizeTimestamp(normalized.timestamp),
      id: normalizeOptionalString(normalized.id),
      messageId: normalizeOptionalString(normalized.messageId),
      originMessageId: normalizeOptionalString(normalized.originMessageId),
      clientId: normalizeOptionalString(normalized.clientId),
      status: normalized.status as SessionTranscriptMessage['status'],
      streaming: typeof normalized.streaming === 'boolean' ? normalized.streaming : undefined,
      agentId: normalizeOptionalString(normalized.agentId),
      toolCallId: normalizeOptionalString(normalized.toolCallId),
      tool_calls: Array.isArray(normalized.tool_calls) ? normalized.tool_calls as Array<Record<string, unknown>> : undefined,
      toolCalls: Array.isArray(normalized.toolCalls) ? normalized.toolCalls as Array<Record<string, unknown>> : undefined,
      toolName: normalizeOptionalString(normalized.toolName),
      metadata: normalized.metadata as Record<string, unknown> | undefined,
      name: normalizeOptionalString(normalized.name),
      details: normalized.details,
      toolStatuses: Array.isArray(normalized.toolStatuses) ? normalized.toolStatuses as Array<Record<string, unknown>> : undefined,
      taskCompletionEvents: normalizeTaskCompletionEvents(normalized.taskCompletionEvents),
      isError: normalizeOptionalBoolean(normalized.isError ?? normalized.is_error),
    });
  }

  return messages;
}

export function materializeTranscriptTimelineEntries(
  sessionKey: string,
  messages: SessionTranscriptMessage[],
  options: {
    existingRows?: SessionTimelineEntry[];
  } = {},
): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  const baselineRows = options.existingRows ?? [];
  for (const [index, message] of messages.entries()) {
    entries.push(...buildTimelineEntriesFromTranscriptMessage(sessionKey, message, {
      index,
      status: resolveTranscriptEntryStatus(message),
      existingRows: [
        ...baselineRows,
        ...entries,
      ],
    }));
  }
  return entries;
}

export function materializeTranscriptToolResultPatchEntries(
  sessionKey: string,
  messages: SessionTranscriptMessage[],
  existingRows: SessionTimelineEntry[],
): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'toolresult' && message.role !== 'tool_result') {
      continue;
    }
    entries.push(...materializeToolResultPatchRows({
      sessionKey,
      message,
      sequenceId: undefined,
      index,
      existingRows: [
        ...existingRows,
        ...entries,
      ],
    }));
  }
  return entries;
}

export function resolveSessionLabelFromTimelineEntries(entries: SessionTimelineEntry[]): string | null {
  return resolveSessionLabelDetailsFromTimelineEntries(entries).label;
}

export function resolveSessionLabelDetailsFromTimelineEntries(entries: SessionTimelineEntry[]): SessionResolvedLabel {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== 'message' || entry.role !== 'user') {
      continue;
    }
    const candidate = resolveUserLabelCandidate(entry.text);
    if (candidate) {
      return {
        label: candidate,
        titleSource: 'user',
      };
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== 'message' || entry.role !== 'assistant') {
      continue;
    }
    const candidate = resolveAssistantLabelCandidate(entry.text);
    if (candidate && !shouldIgnoreAssistantSessionLabel(candidate)) {
      return {
        label: candidate,
        titleSource: 'assistant',
      };
    }
  }

  return {
    label: null,
    titleSource: 'none',
  };
}
