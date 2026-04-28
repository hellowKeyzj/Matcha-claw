import { readFile } from 'node:fs/promises';
import { SessionFileResolver } from './session-file-resolver';

type SessionWindowMode = 'latest' | 'older' | 'newer';

interface SessionWindowServiceDeps {
  getOpenClawConfigDir: () => string;
}

interface SessionWindowPayload {
  sessionKey?: unknown;
  mode?: unknown;
  limit?: unknown;
  offset?: unknown;
  includeCanonical?: unknown;
}

interface TranscriptMessageShape {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  id?: unknown;
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
  timestamp?: unknown;
  message?: TranscriptMessageShape;
}

interface SessionWindowMessage {
  role: 'user' | 'assistant' | 'system' | 'toolresult' | 'tool_result';
  content: unknown;
  timestamp?: number;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
}

export interface SessionWindowResponse {
  messages: SessionWindowMessage[];
  canonicalMessages?: SessionWindowMessage[];
  totalMessageCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMode(value: unknown): SessionWindowMode {
  if (typeof value !== 'string') {
    return 'latest';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'older' || normalized === 'newer') {
    return normalized;
  }
  return 'latest';
}

function normalizeLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(Math.max(Math.floor(value), 0), 200);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(Math.floor(parsed), 0), 200);
    }
  }
  return 80;
}

function normalizeOffset(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(Math.floor(value), 0);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(Math.floor(parsed), 0);
    }
  }
  return null;
}

function normalizeIncludeCanonical(value: unknown): boolean {
  return value === true;
}

function normalizeRole(value: unknown): SessionWindowMessage['role'] | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'user'
    || normalized === 'assistant'
    || normalized === 'system'
    || normalized === 'toolresult'
    || normalized === 'tool_result'
  ) {
    return normalized;
  }
  return null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
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

function parseTranscriptMessages(content: string): SessionWindowMessage[] {
  const lines = content.split(/\r?\n/).filter(Boolean);
  const messages: SessionWindowMessage[] = [];

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

    const role = normalizeRole(parsed.message.role);
    if (!role) {
      continue;
    }

    messages.push({
      role,
      content: Object.prototype.hasOwnProperty.call(parsed.message, 'content')
        ? parsed.message.content
        : '',
      timestamp: normalizeTimestamp(parsed.timestamp ?? parsed.message.timestamp),
      id: normalizeOptionalString(parsed.message.id),
      toolCallId: normalizeOptionalString(parsed.message.toolCallId ?? parsed.message.tool_call_id),
      toolName: normalizeOptionalString(parsed.message.toolName ?? parsed.message.tool_name ?? parsed.message.name),
      details: parsed.message.details,
      isError: normalizeOptionalBoolean(parsed.message.isError ?? parsed.message.is_error),
    });
  }

  return messages;
}

function buildWindowRange(input: {
  totalMessageCount: number;
  mode: SessionWindowMode;
  limit: number;
  offset: number | null;
}): { start: number; end: number } {
  const { totalMessageCount, mode, limit, offset } = input;
  if (mode === 'older') {
    const end = Math.min(Math.max(offset ?? totalMessageCount, 0), totalMessageCount);
    return {
      start: Math.max(0, end - limit),
      end,
    };
  }
  if (mode === 'newer') {
    const start = Math.min(Math.max(offset ?? totalMessageCount, 0), totalMessageCount);
    return {
      start,
      end: Math.min(totalMessageCount, start + limit),
    };
  }
  return {
    start: Math.max(0, totalMessageCount - limit),
    end: totalMessageCount,
  };
}

export class SessionWindowService {
  private readonly fileResolver: SessionFileResolver;

  constructor(private readonly deps: SessionWindowServiceDeps) {
    this.fileResolver = new SessionFileResolver({ getOpenClawConfigDir: deps.getOpenClawConfigDir });
  }

  async getWindow(payload: unknown) {
    const body = isRecord(payload) ? payload as SessionWindowPayload : {};
    const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
    if (!sessionKey) {
      return {
        status: 400,
        data: { success: false, error: 'sessionKey is required' },
      };
    }

    const resolution = await this.fileResolver.resolve(sessionKey);
    if (!resolution) {
      return {
        status: 404,
        data: { success: false, error: `Cannot resolve transcript for session: ${sessionKey}` },
      };
    }

    const mode = normalizeMode(body.mode);
    const limit = normalizeLimit(body.limit);
    const offset = normalizeOffset(body.offset);
    const includeCanonical = normalizeIncludeCanonical(body.includeCanonical);

    if ((mode === 'older' || mode === 'newer') && offset == null) {
      return {
        status: 400,
        data: { success: false, error: `offset is required for mode: ${mode}` },
      };
    }

    const content = await readFile(resolution.transcriptPath, 'utf8');
    const allMessages = parseTranscriptMessages(content);
    const totalMessageCount = allMessages.length;
    const { start, end } = buildWindowRange({
      totalMessageCount,
      mode,
      limit,
      offset,
    });
    const messages = allMessages.slice(start, end);

    const response: SessionWindowResponse = {
      messages,
      ...(includeCanonical ? { canonicalMessages: allMessages } : {}),
      totalMessageCount,
      windowStartOffset: start,
      windowEndOffset: end,
      hasMore: start > 0,
      hasNewer: end < totalMessageCount,
      isAtLatest: end >= totalMessageCount,
    };

    return {
      status: 200,
      data: response,
    };
  }
}
