import {
  extractMessageText,
  normalizeAssistantFinalText as normalizeAssistantFinalTextShared,
  normalizeMessageRole,
  normalizeOptionalString,
  normalizeRawChatMessage,
  sanitizeCanonicalUserText,
} from '../../shared/chat-message-normalization';
import type { SessionTaskCompletionEvent } from '../../shared/session-adapter-types';
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

function shouldIgnoreAssistantSessionLabel(text: string): boolean {
  if (!text) {
    return true;
  }
  return ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS.some((pattern) => pattern.test(text));
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
      taskCompletionEvents: normalizeTaskCompletionEvents({
        taskCompletionEvents: normalized.taskCompletionEvents,
        internalEvents: normalized.internalEvents,
      }),
      isError: normalizeOptionalBoolean(normalized.isError ?? normalized.is_error),
    });
  }

  return messages;
}

export function resolveTranscriptSessionLabel(messages: SessionTranscriptMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') {
      continue;
    }
    const candidate = resolveUserLabelCandidate(message.content);
    if (candidate) {
      return candidate;
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }
    const candidate = resolveAssistantLabelCandidate(message.content);
    if (candidate && !shouldIgnoreAssistantSessionLabel(candidate)) {
      return candidate;
    }
  }

  return null;
}
