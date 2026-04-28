import intermediateToolFillerBlacklistConfig from '@/constants/intermediate-tool-filler-blacklist.json';
import { isToolResultRole } from './event-helpers';
import type { ContentBlock, RawMessage } from './types';

const SESSION_LABEL_MAX_LENGTH = 50;
const ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS: RegExp[] = [
  /^a new session was started via\b/i,
  /^##\s*task manager\b/i,
  /^task manager.*(恢复提示|动态切换建议)/i,
  /^检测到多个待确认任务/i,
];

const INTERMEDIATE_TOOL_PHRASE_STATS_KEY = 'clawx:intermediate-tool-phrase-stats:v1';
const INTERMEDIATE_TOOL_PHRASE_STATS_MAX_ITEMS = 200;
const INTERMEDIATE_TOOL_PHRASE_TRACK_MAX_LENGTH = 120;

interface IntermediateToolPhraseStat {
  sample: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

type IntermediateToolPhraseStats = Record<string, IntermediateToolPhraseStat>;

function normalizeIntermediateToolPhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"'“”]/g, '')
    .replace(/[，。！!？?、,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildIntermediateToolFillerBlacklist(source: unknown): Set<string> {
  if (!Array.isArray(source)) return new Set<string>();
  const normalized = source
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeIntermediateToolPhrase(item))
    .filter((item) => item.length > 0);
  return new Set<string>(normalized);
}

const INTERMEDIATE_TOOL_FILLER_BLACKLIST = buildIntermediateToolFillerBlacklist(
  intermediateToolFillerBlacklistConfig,
);

function loadIntermediateToolPhraseStats(): IntermediateToolPhraseStats {
  try {
    const raw = localStorage.getItem(INTERMEDIATE_TOOL_PHRASE_STATS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as IntermediateToolPhraseStats;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveIntermediateToolPhraseStats(stats: IntermediateToolPhraseStats): void {
  try {
    const entries = Object.entries(stats);
    entries.sort((a, b) => {
      const countDiff = (b[1]?.count ?? 0) - (a[1]?.count ?? 0);
      if (countDiff !== 0) return countDiff;
      return (b[1]?.lastSeenAt ?? 0) - (a[1]?.lastSeenAt ?? 0);
    });
    const trimmed = entries.slice(0, INTERMEDIATE_TOOL_PHRASE_STATS_MAX_ITEMS);
    localStorage.setItem(INTERMEDIATE_TOOL_PHRASE_STATS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // 忽略 localStorage 配额或序列化错误
  }
}

function getAssistantText(message: RawMessage | undefined): string {
  if (!message || typeof message !== 'object') return '';
  const fromContent = getMessageText(message.content).trim();
  if (fromContent) return fromContent;
  const row = message as unknown as Record<string, unknown>;
  return typeof row.text === 'string' ? row.text.trim() : '';
}

export function hasAssistantToolCall(message: RawMessage | undefined): boolean {
  if (!message || typeof message !== 'object') return false;
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'tool_use' || block.type === 'toolCall') return true;
    }
  }
  const row = message as unknown as Record<string, unknown>;
  const toolCalls = row.tool_calls ?? row.toolCalls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

function shouldTrackIntermediateToolPhrase(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > INTERMEDIATE_TOOL_PHRASE_TRACK_MAX_LENGTH) return false;
  return !trimmed.includes('\n');
}

function recordIntermediateToolPhrase(text: string): void {
  if (!shouldTrackIntermediateToolPhrase(text)) return;
  const normalized = normalizeIntermediateToolPhrase(text);
  if (!normalized) return;

  const now = Date.now();
  const stats = loadIntermediateToolPhraseStats();
  const current = stats[normalized];
  const nextCount = (current?.count ?? 0) + 1;
  stats[normalized] = {
    sample: text.trim().slice(0, INTERMEDIATE_TOOL_PHRASE_TRACK_MAX_LENGTH),
    count: nextCount,
    firstSeenAt: current?.firstSeenAt ?? now,
    lastSeenAt: now,
  };
  saveIntermediateToolPhraseStats(stats);
}

function isBlacklistedIntermediateToolPhrase(text: string): boolean {
  const normalized = normalizeIntermediateToolPhrase(text);
  return normalized.length > 0 && INTERMEDIATE_TOOL_FILLER_BLACKLIST.has(normalized);
}

function stripAssistantTextForToolFiller(message: RawMessage): RawMessage {
  const row = message as unknown as Record<string, unknown>;
  const nextRow: Record<string, unknown> = { ...row };
  let changed = false;

  if (typeof nextRow.content === 'string') {
    if (nextRow.content.trim().length > 0) {
      nextRow.content = '';
      changed = true;
    }
  } else if (Array.isArray(nextRow.content)) {
    const nextContent = (nextRow.content as ContentBlock[]).filter((block) => block.type !== 'text');
    if (nextContent.length !== nextRow.content.length) {
      nextRow.content = nextContent;
      changed = true;
    }
  }

  if (typeof nextRow.text === 'string' && nextRow.text.trim().length > 0) {
    nextRow.text = '';
    changed = true;
  }

  return changed ? nextRow as unknown as RawMessage : message;
}

function shouldTreatAsIntermediateToolTurn(
  message: RawMessage | undefined,
  nextMessage?: RawMessage,
  requireFollower = false,
): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (!hasAssistantToolCall(message)) return false;
  if (!getAssistantText(message)) return false;
  if (!requireFollower) return true;
  if (!nextMessage) return false;
  if (isToolResultRole(nextMessage.role)) return true;
  return nextMessage.role === 'assistant';
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
  return `${cleaned.slice(0, SESSION_LABEL_MAX_LENGTH)}…`;
}

function shouldIgnoreAssistantSessionLabel(text: string): boolean {
  if (!text) {
    return true;
  }
  return ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Extract plain text from message content (string or content blocks) */
export function getMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n');
  }
  return '';
}

export function extractUserMessageClientId(content: unknown): string | null {
  const text = getMessageText(content);
  const matched = text.match(/\[message_id:\s*([^\]]+)\]/i);
  if (!matched) {
    return null;
  }
  const candidate = matched[1]?.trim();
  return candidate ? candidate : null;
}

export function buildUserTransportMessage(
  text: string,
  clientMessageId: string,
): string {
  const normalizedId = clientMessageId.trim();
  if (!normalizedId) {
    return text;
  }
  const currentClientId = extractUserMessageClientId(text);
  if (currentClientId === normalizedId) {
    return text;
  }
  const normalizedText = text.trim();
  return normalizedText
    ? `${normalizedText} [message_id: ${normalizedId}]`
    : `[message_id: ${normalizedId}]`;
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
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^Sender\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i, '')
    .replace(/^Sender\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, '')
    .replace(/^\s*[^\n:]{1,80}\s*\(\s*untrusted metadata\s*\):\s*/i, '');
  return stripLeadingUntrustedMetadataBlocks(cleaned).trim();
}

export function normalizeUserTextForReconcile(content: unknown): string {
  const raw = getMessageText(content);
  if (!raw) return '';
  return cleanGatewayUserText(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/\s*([，。！？：；,.!?;:])\s*/g, '$1')
    .trim();
}

export function normalizeAssistantFinalTextForDedup(content: unknown): string {
  return getMessageText(content)
    .replace(/^\s*(?:\[\[reply_to(?:[:_][a-z0-9:_-]+)?\]\]\s*)+/ig, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveSessionLabelCandidateFromUserMessage(content: unknown): string {
  return normalizeSessionLabelText(cleanGatewayUserText(getMessageText(content)));
}

function resolveSessionLabelCandidateFromAssistantMessage(content: unknown): string {
  return normalizeSessionLabelText(normalizeAssistantFinalTextForDedup(content));
}

export function createIntermediateToolTurnSnapshot(
  message: RawMessage,
  id: string,
): RawMessage {
  const normalizedMessage: RawMessage = {
    ...message,
    role: 'assistant',
    id,
  };
  if (!hasAssistantToolCall(normalizedMessage)) {
    return normalizedMessage;
  }
  return stripAssistantTextForToolFiller(normalizedMessage);
}

export function sanitizeIntermediateToolFillerMessage(
  message: RawMessage,
  options?: {
    nextMessage?: RawMessage;
    requireFollower?: boolean;
    trackPhrase?: boolean;
  },
): RawMessage {
  const requireFollower = options?.requireFollower ?? false;
  if (!shouldTreatAsIntermediateToolTurn(message, options?.nextMessage, requireFollower)) {
    return message;
  }

  const text = getAssistantText(message);
  if (!text) return message;
  if (options?.trackPhrase) {
    recordIntermediateToolPhrase(text);
  }
  if (!isBlacklistedIntermediateToolPhrase(text)) {
    return message;
  }
  return stripAssistantTextForToolFiller(message);
}

export function resolveSessionLabelFromMessages(messages: RawMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') {
      continue;
    }
    const candidate = resolveSessionLabelCandidateFromUserMessage(message.content);
    if (candidate) {
      return candidate;
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }
    const candidate = resolveSessionLabelCandidateFromAssistantMessage(message.content);
    if (candidate && !shouldIgnoreAssistantSessionLabel(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function isToolOnlyMessage(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (isToolResultRole(message.role)) return true;

  const msg = message as unknown as Record<string, unknown>;
  const content = message.content;

  // Check OpenAI-format tool_calls field (real-time streaming from OpenAI-compatible models)
  const toolCalls = msg.tool_calls ?? msg.toolCalls;
  const hasOpenAITools = Array.isArray(toolCalls) && toolCalls.length > 0;

  if (!Array.isArray(content)) {
    // Content is not an array — check if there's OpenAI-format tool_calls
    if (hasOpenAITools) {
      // Has tool calls but content might be empty/string — treat as tool-only
      // if there's no meaningful text content
      const textContent = typeof content === 'string' ? content.trim() : '';
      return textContent.length === 0;
    }
    return false;
  }

  let hasTool = hasOpenAITools;
  let hasText = false;
  let hasNonToolContent = false;

  for (const block of content as ContentBlock[]) {
    if (block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'toolCall' || block.type === 'toolResult') {
      hasTool = true;
      continue;
    }
    if (block.type === 'text' && block.text && block.text.trim()) {
      hasText = true;
      continue;
    }
    // Only actual image output disqualifies a tool-only message.
    // Thinking blocks are internal reasoning that can accompany tool_use — they
    // should NOT prevent the message from being treated as an intermediate tool step.
    if (block.type === 'image') {
      hasNonToolContent = true;
    }
  }

  return hasTool && !hasText && !hasNonToolContent;
}

export function isInternalMessage(msg: Pick<RawMessage, 'role' | 'content'>): boolean {
  if (!msg) {
    return false;
  }
  if (msg.role === 'system') {
    return true;
  }
  if (msg.role === 'assistant') {
    const text = getMessageText(msg.content).trim();
    if (/^(HEARTBEAT_OK|NO_REPLY)$/.test(text)) {
      return true;
    }
  }
  return false;
}
