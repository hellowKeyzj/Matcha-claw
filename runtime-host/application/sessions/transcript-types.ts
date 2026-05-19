import type { SessionTaskCompletionEvent } from '../../shared/session-adapter-types';

export interface SessionTranscriptMessage {
  role: 'user' | 'assistant' | 'system' | 'toolresult' | 'tool_result';
  content: unknown;
  text?: string;
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

export interface TranscriptMessageShape {
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
  taskCompletionEvents?: unknown;
  _attachedFiles?: unknown;
}

export interface TranscriptLineShape {
  id?: unknown;
  timestamp?: unknown;
  message?: TranscriptMessageShape;
}

export interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  data?: unknown;
  mimeType?: unknown;
  url?: unknown;
  alt?: unknown;
  id?: unknown;
  name?: unknown;
  function?: unknown;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function normalizeTimestamp(value: unknown): number | undefined {
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
