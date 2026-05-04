import {
  extractMessageText,
  normalizeAssistantFinalText as normalizeAssistantFinalTextShared,
  normalizeMessageRole,
  normalizeOptionalString,
  normalizeRawChatMessage,
  sanitizeAssistantDisplayText,
  sanitizeCanonicalUserText,
} from '../../shared/chat-message-normalization';
import type {
  SessionCatalogTitleSource,
  SessionMessageRow,
  SessionRenderRow,
  SessionRowStatus,
  SessionTaskCompletionEvent,
  SessionTaskCompletionRow,
  SessionToolActivityRow,
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
  uniqueId?: string;
  requestId?: string;
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
  uniqueId?: unknown;
  unique_id?: unknown;
  requestId?: unknown;
  request_id?: unknown;
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

function resolveTurnIdentity(
  message: SessionTranscriptMessage,
  options: {
    runId?: string;
  } = {},
): string {
  return normalizeOptionalString(options.runId)
    ?? normalizeOptionalString(message.messageId ?? message.id)
    ?? normalizeOptionalString(message.originMessageId)
    ?? normalizeOptionalString(message.clientId)
    ?? normalizeOptionalString(message.uniqueId)
    ?? normalizeOptionalString(message.requestId)
    ?? '';
}

function resolveRowId(
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
    ?? message.clientId
    ?? message.uniqueId
    ?? message.requestId,
  ) ?? (() => {
    const runId = normalizeOptionalString(options.runId);
    if (runId) {
      const agentId = normalizeOptionalString(message.agentId);
      return agentId
        ? `run:${runId}:agent:${agentId}:${message.role || 'message'}:${index}`
        : `run:${runId}:${message.role || 'message'}:${index}`;
    }
    return `row-${index}`;
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

function extractImages(message: SessionTranscriptMessage): SessionMessageRow['images'] {
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return [];
  }
  const images: SessionMessageRow['images'] = [];
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

function extractToolUses(message: SessionTranscriptMessage): SessionMessageRow['toolUses'] {
  const content = readMessageContent(message);
  const tools: SessionMessageRow['toolUses'] = [];
  if (Array.isArray(content)) {
    for (const block of content as ContentBlockLike[]) {
      const type = typeof block.type === 'string' ? block.type : '';
      const name = typeof block.name === 'string' ? block.name.trim() : '';
      if (!name || (type !== 'tool_use' && type !== 'toolCall')) {
        continue;
      }
      tools.push({
        id: typeof block.id === 'string' && block.id.trim() ? block.id : name,
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
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : '';
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
      id: id || name,
      name,
      input,
    }];
  });
}

function readAttachedFiles(message: SessionTranscriptMessage): SessionMessageRow['attachedFiles'] {
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

function readToolStatuses(message: SessionTranscriptMessage): SessionMessageRow['toolStatuses'] {
  const toolStatuses = message.toolStatuses;
  if (!Array.isArray(toolStatuses)) {
    return [];
  }
  return toolStatuses.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined;
    const toolCallId = typeof row.toolCallId === 'string' && row.toolCallId.trim() ? row.toolCallId.trim() : undefined;
    const fallbackName = normalizeOptionalString(message.toolName ?? message.name ?? toolCallId ?? id) ?? '';
    const name = typeof row.name === 'string' && row.name.trim()
      ? row.name.trim()
      : fallbackName;
    const status = row.status === 'running' || row.status === 'completed' || row.status === 'error'
      ? row.status
      : null;
    if (!name || !status) {
      return [];
    }
    const summary = typeof row.summary === 'string' && row.summary.trim() ? row.summary.trim() : undefined;
    const durationMs = typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? row.durationMs : undefined;
    const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : undefined;
    return [{
      ...(id ? { id } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      name,
      status,
      ...(summary ? { summary } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      ...(updatedAt != null ? { updatedAt } : {}),
    }];
  });
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

function extractImagesAsAttachedFiles(content: unknown): SessionMessageRow['attachedFiles'] {
  if (!Array.isArray(content)) {
    return [];
  }
  const files: SessionMessageRow['attachedFiles'] = [];
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
  existingFiles: ReadonlyArray<SessionMessageRow['attachedFiles'][number]>,
  incomingFiles: ReadonlyArray<SessionMessageRow['attachedFiles'][number]>,
): SessionMessageRow['attachedFiles'] {
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
  rows: SessionRenderRow[],
  laneKey: string,
  turnKey: string,
): SessionMessageRow | SessionToolActivityRow | null {
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

function materializeToolResultRows(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  status: SessionRowStatus;
  runId?: string;
  sequenceId?: number;
  createdAt?: number;
  rowId: string;
  laneKey: string;
  turnKey: string;
  agentId: string;
  text: string;
  existingRows: SessionRenderRow[];
}): SessionRenderRow[] {
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
  const existingAssistantRow = findLatestAssistantContentRow(input.existingRows, input.laneKey, input.turnKey);
  const existingToolUses = existingAssistantRow?.toolUses ?? [];
  if (existingAssistantRow?.kind === 'message') {
    return [{
      ...existingAssistantRow,
      key: existingAssistantRow.key,
      status: input.status,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
      createdAt: input.createdAt ?? existingAssistantRow.createdAt,
      sourceRole: input.message.role,
      attachedFiles: mergeAttachedFiles(existingAssistantRow.attachedFiles, attachedFiles),
      toolStatuses: toolStatuses.length > 0 ? toolStatuses : existingAssistantRow.toolStatuses,
      isStreaming: input.status === 'streaming' || existingAssistantRow.isStreaming,
    }];
  }
  return [{
    key: existingAssistantRow?.key ?? `session:${input.sessionKey}|tool-activity:${input.rowId}`,
    kind: 'tool-activity',
    sessionKey: input.sessionKey,
    role: 'assistant',
    text: input.text,
    createdAt: input.createdAt,
    status: input.status,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
    rowId: existingAssistantRow?.rowId ?? input.rowId,
    laneKey: input.laneKey,
    turnKey: input.turnKey,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    sourceRole: input.message.role,
    assistantTurnKey: input.turnKey,
    assistantLaneKey: input.laneKey,
    assistantLaneAgentId: input.agentId || null,
    toolUses: existingToolUses,
    toolStatuses,
    attachedFiles,
    isStreaming: input.status === 'streaming' || Boolean(input.message.streaming),
  }];
}

function buildTaskCompletionText(row: SessionTaskCompletionRow): string {
  return [
    row.taskLabel,
    row.statusLabel,
    row.result,
  ].filter((value) => typeof value === 'string' && value.trim()).join(' · ');
}

function resolveCompletionTriggerRow(
  rows: SessionRenderRow[],
  fallbackRowId: string,
): SessionRenderRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'user') {
      continue;
    }
    if (row.kind === 'task-completion' || row.rowId === fallbackRowId) {
      continue;
    }
    return row;
  }
  return null;
}

export function resolveTranscriptEntryStatus(message: SessionTranscriptMessage): SessionRowStatus {
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

export function buildRowsFromTranscriptMessage(
  sessionKey: string,
  message: SessionTranscriptMessage,
  options: {
    runId?: string;
    sequenceId?: number;
    status?: SessionRowStatus;
    index: number;
    existingRows?: SessionRenderRow[];
  },
): SessionRenderRow[] {
  const agentId = normalizeOptionalString(message.agentId) ?? '';
  const laneKey = resolveSessionLaneKey(agentId);
  const turnIdentity = resolveTurnIdentity(message, {
    runId: options.runId,
  });
  const rowId = resolveRowId(message, options.index, {
    runId: options.runId,
    sequenceId: options.sequenceId,
  });
  const status = options.status ?? 'final';
  const createdAt = message.timestamp;
  const text = resolveDisplayText(message);
  const turnKey = turnIdentity ? `${laneKey}:${turnIdentity}` : `${laneKey}:row:${rowId}`;
  const existingRows = options.existingRows ?? [];

  if (message.role === 'toolresult' || message.role === 'tool_result') {
    return materializeToolResultRows({
      sessionKey,
      message,
      status,
      runId: options.runId,
      sequenceId: options.sequenceId,
      createdAt,
      rowId,
      laneKey,
      turnKey,
      agentId,
      text,
      existingRows,
    });
  }

  const toolUses = extractToolUses(message);
  const toolStatuses = readToolStatuses(message);
  const thinking = extractThinking(message);
  const images = extractImages(message);
  const attachedFiles = readAttachedFiles(message);
  const role = message.role === 'user' || message.role === 'system' ? message.role : 'assistant';
  const base = {
    key: `session:${sessionKey}|row:${rowId}`,
    sessionKey,
    role,
    text,
    createdAt,
    status,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.sequenceId != null ? { sequenceId: options.sequenceId } : {}),
    rowId,
    laneKey,
    turnKey,
    ...(agentId ? { agentId } : {}),
      ...(role === 'assistant' ? {
        sourceRole: message.role,
        assistantTurnKey: turnKey,
        assistantLaneKey: laneKey,
        assistantLaneAgentId: agentId || null,
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

  const rows: SessionRenderRow[] = [];
  if (isToolActivity) {
    rows.push({
      ...base,
      kind: 'tool-activity',
      role: 'assistant',
      toolUses,
      toolStatuses,
      attachedFiles: [],
      isStreaming: status === 'streaming' || Boolean(message.streaming),
    });
  } else {
    rows.push({
      ...base,
      kind: 'message',
      thinking,
      images,
      toolUses,
      attachedFiles,
      toolStatuses,
      isStreaming: status === 'streaming' || Boolean(message.streaming),
      ...(message.messageId || rowId ? { messageId: message.messageId || rowId } : {}),
      ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
      ...(message.clientId ? { clientId: message.clientId } : {}),
      ...(message.uniqueId ? { uniqueId: message.uniqueId } : {}),
      ...(message.requestId ? { requestId: message.requestId } : {}),
    });
  }

  const completionEvents = Array.isArray(message.taskCompletionEvents) ? message.taskCompletionEvents : [];
  for (const [completionIndex, event] of completionEvents.entries()) {
    const triggerRow = resolveCompletionTriggerRow(existingRows, rowId);
    const completionRow: SessionTaskCompletionRow = {
      key: `session:${sessionKey}|completion:${rowId}:${completionIndex}`,
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
      rowId,
      childSessionKey: event.childSessionKey,
      ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
      ...(event.childAgentId ? { childAgentId: event.childAgentId } : {}),
      ...(event.taskLabel ? { taskLabel: event.taskLabel } : {}),
      ...(event.statusLabel ? { statusLabel: event.statusLabel } : {}),
      ...(event.result ? { result: event.result } : {}),
      ...(event.statsLine ? { statsLine: event.statsLine } : {}),
      ...(event.replyInstruction ? { replyInstruction: event.replyInstruction } : {}),
      ...(triggerRow?.key ? { triggerRowKey: triggerRow.key } : {}),
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
      fallbackMessageIdToId: true,
      fallbackOriginMessageIdToParentMessageId: true,
      fallbackUniqueIdToId: true,
      fallbackRequestIdToClientId: true,
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
      uniqueId: normalizeOptionalString(normalized.uniqueId),
      requestId: normalizeOptionalString(normalized.requestId),
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

export function materializeTranscriptRows(
  sessionKey: string,
  messages: SessionTranscriptMessage[],
): SessionRenderRow[] {
  const rows: SessionRenderRow[] = [];
  for (const [index, message] of messages.entries()) {
    rows.push(...buildRowsFromTranscriptMessage(sessionKey, message, {
      index,
      status: resolveTranscriptEntryStatus(message),
      existingRows: rows,
    }));
  }
  return rows;
}

export function resolveSessionLabelFromRows(rows: SessionRenderRow[]): string | null {
  return resolveSessionLabelDetailsFromRows(rows).label;
}

export function resolveSessionLabelDetailsFromRows(rows: SessionRenderRow[]): SessionResolvedLabel {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind !== 'message' || row.role !== 'user') {
      continue;
    }
    const candidate = resolveUserLabelCandidate(row.text);
    if (candidate) {
      return {
        label: candidate,
        titleSource: 'user',
      };
    }
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind !== 'message' || row.role !== 'assistant') {
      continue;
    }
    const candidate = resolveAssistantLabelCandidate(row.text);
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
