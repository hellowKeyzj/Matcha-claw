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
  clientId?: string;
  uniqueId?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
}

interface TranscriptMessageShape {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  id?: unknown;
  messageId?: unknown;
  message_id?: unknown;
  clientId?: unknown;
  client_id?: unknown;
  uniqueId?: unknown;
  unique_id?: unknown;
  idempotencyKey?: unknown;
  idempotency_key?: unknown;
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

function normalizeRole(value: unknown): SessionTranscriptMessage['role'] | null {
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

function getMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n');
}

function stripLeadingUntrustedMetadataBlocks(text: string): string {
  const fencedPattern = /^\s*(?:[^\n:]{1,80}\s*\(\s*untrusted metadata\s*\):\s*)?```[a-z]*\n[\s\S]*?```\s*/i;
  const inlineJsonPattern = /^\s*(?:[^\n:]{1,80}\s*\(\s*untrusted metadata\s*\):\s*)?\{[\s\S]*?\}\s*/i;

  let output = text;
  while (true) {
    const next = output
      .replace(fencedPattern, '')
      .replace(inlineJsonPattern, '');
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function cleanGatewayUserText(text: string): string {
  const cleaned = text
    .replace(/\s*\[media attached:[^\]]*\]/gi, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/gi, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, '')
    .replace(/^\s*[^\n:]{1,80}\s*\(\s*untrusted metadata\s*\):\s*/i, '');
  return stripLeadingUntrustedMetadataBlocks(cleaned).trim();
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
  return getMessageText(content)
    .replace(/^\s*(?:\[\[reply_to(?:[:_][a-z0-9:_-]+)?\]\]\s*)+/ig, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveUserLabelCandidate(content: unknown): string {
  return normalizeSessionLabelText(cleanGatewayUserText(getMessageText(content)));
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
      id: normalizeOptionalString(parsed.id ?? parsed.message.id),
      messageId: normalizeOptionalString(parsed.message.messageId ?? parsed.message.message_id ?? parsed.message.id),
      clientId: normalizeOptionalString(parsed.message.clientId ?? parsed.message.client_id ?? parsed.message.idempotencyKey ?? parsed.message.idempotency_key),
      uniqueId: normalizeOptionalString(parsed.message.uniqueId ?? parsed.message.unique_id ?? parsed.id),
      toolCallId: normalizeOptionalString(parsed.message.toolCallId ?? parsed.message.tool_call_id),
      toolName: normalizeOptionalString(parsed.message.toolName ?? parsed.message.tool_name ?? parsed.message.name),
      details: parsed.message.details,
      isError: normalizeOptionalBoolean(parsed.message.isError ?? parsed.message.is_error),
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
