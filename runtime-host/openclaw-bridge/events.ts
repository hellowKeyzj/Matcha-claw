import type { GatewayNotification } from './protocol';
import { createRuntimeLogger } from '../shared/logger';

const gatewayProtocolLogger = createRuntimeLogger('gateway-protocol');
const AGENT_EMBEDDED_MESSAGE_WARN_LIMIT = 20;
let agentEmbeddedMessageWarnCount = 0;
const CHAT_EVENT_SEMANTIC_DEDUP_WINDOW_MS = 1_200;
const recentNormalizedChatEvents = new Map<string, { seenAt: number; runId: string }>();

type GatewayRunPhase = 'started' | 'completed' | 'error' | 'aborted';

export type GatewayConversationEvent =
  | {
    type: 'chat.message';
    event: Record<string, unknown>;
  }
  | {
    type: 'run.phase';
    phase: GatewayRunPhase;
    runId?: string;
    sessionKey?: string;
  };

export type GatewayProtocolEventDispatcher = {
  emitNotification: (notification: GatewayNotification) => void;
  emitConversationEvent: (payload: GatewayConversationEvent) => void;
  emitChannelStatus: (payload: { channelId: string; status: string }) => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    const row = asRecord(block);
    if (!row) {
      continue;
    }
    if (row.type !== 'text' || typeof row.text !== 'string') {
      continue;
    }
    parts.push(row.text);
  }
  return parts.join('\n');
}

function normalizeReplyDirectivePrefix(text: string): string {
  return text
    .replace(/^\s*(?:\[\[reply_to_[a-z0-9:_-]+\]\]\s*)+/ig, '')
    .trim();
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

function cleanGatewayUserTextForDedup(text: string): string {
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

function normalizeWhitespaceForDedup(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/\s*([，。！？：；,.!?;:])\s*/g, '$1')
    .trim();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function normalizeGatewayChatState(
  payload: Record<string, unknown>,
  message: Record<string, unknown>,
): string {
  const fromPayload = getTrimmedString(payload.state || payload.phase).toLowerCase();
  const fromMessage = getTrimmedString(message.state || message.phase).toLowerCase();
  const state = fromPayload || fromMessage;
  if (state) {
    if (state === 'completed' || state === 'done' || state === 'finished' || state === 'end') {
      return 'final';
    }
    return state;
  }

  const stopReason = payload.stopReason ?? payload.stop_reason ?? message.stopReason ?? message.stop_reason;
  if (stopReason != null) {
    return 'final';
  }
  if (message.role != null || message.content != null || message.text != null) {
    // Legacy chat payloads often omit explicit state while still being part of
    // a streaming sequence. Default to delta and let explicit state/stopReason
    // close the turn as final.
    return 'delta';
  }
  return '';
}

function normalizeGatewayChatEvent(payload: unknown): Record<string, unknown> | null {
  const input = asRecord(payload);
  if (!input) {
    return null;
  }
  const nestedMessage = asRecord(input.message);
  const message = nestedMessage ?? input;
  const state = normalizeGatewayChatState(input, message);
  if (!state) {
    return null;
  }

  const runId = getTrimmedString(input.runId ?? message.runId);
  const sessionKey = getTrimmedString(input.sessionKey ?? message.sessionKey);
  return {
    state,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    message,
  };
}

function buildNormalizedChatDedupCoreKey(normalizedEvent: Record<string, unknown>): string {
  const state = getTrimmedString(normalizedEvent.state);
  const message = asRecord(normalizedEvent.message) ?? {};
  const role = getTrimmedString(message.role).toLowerCase();
  const toolCallId = getTrimmedString(message.toolCallId);
  const rawText = extractMessageText(message.content ?? message.text ?? '');
  const normalizedRawText = (() => {
    if (role === 'assistant') {
      return normalizeReplyDirectivePrefix(rawText);
    }
    if (role === 'user') {
      return cleanGatewayUserTextForDedup(rawText);
    }
    return rawText.trim();
  })();
  const text = normalizeWhitespaceForDedup(normalizedRawText);
  const fallbackContentSig = !text
    ? safeStringify(message.content ?? message.text ?? null)
    : '';
  return [state, role, toolCallId, text, fallbackContentSig].join('|');
}

function buildNormalizedChatDedupKeys(normalizedEvent: Record<string, unknown>): string[] {
  const core = buildNormalizedChatDedupCoreKey(normalizedEvent);
  const sessionKey = getTrimmedString(normalizedEvent.sessionKey);
  if (!sessionKey) {
    return [`chat:${core}`];
  }
  return [
    `chat:${core}`,
    `chat:${sessionKey}|${core}`,
  ];
}

function pruneRecentNormalizedChatEvents(nowMs: number): void {
  for (const [key, seen] of recentNormalizedChatEvents.entries()) {
    if (nowMs - seen.seenAt > CHAT_EVENT_SEMANTIC_DEDUP_WINDOW_MS) {
      recentNormalizedChatEvents.delete(key);
    }
  }
}

function isDuplicateNormalizedChatEvent(normalizedEvent: Record<string, unknown>): boolean {
  const state = getTrimmedString(normalizedEvent.state).toLowerCase();
  if (state !== 'final') {
    return false;
  }

  const nowMs = Date.now();
  pruneRecentNormalizedChatEvents(nowMs);
  const dedupKeys = buildNormalizedChatDedupKeys(normalizedEvent);
  const runId = getTrimmedString(normalizedEvent.runId);

  for (const dedupKey of dedupKeys) {
    const previous = recentNormalizedChatEvents.get(dedupKey);
    if (!previous || nowMs - previous.seenAt > CHAT_EVENT_SEMANTIC_DEDUP_WINDOW_MS) {
      continue;
    }
    if (previous.runId && runId && previous.runId !== runId) {
      continue;
    }
    return true;
  }

  for (const dedupKey of dedupKeys) {
    recentNormalizedChatEvents.set(dedupKey, { seenAt: nowMs, runId });
  }
  return false;
}

function normalizeGatewayRunPhase(payload: unknown): {
  phase: GatewayRunPhase;
  runId?: string;
  sessionKey?: string;
} | null {
  const input = asRecord(payload) ?? {};
  const data = asRecord(input.data) ?? {};
  const phaseRaw = getTrimmedString(data.phase ?? input.phase ?? data.state ?? input.state).toLowerCase();
  if (!phaseRaw) {
    return null;
  }

  const phase = (() => {
    if (phaseRaw === 'start' || phaseRaw === 'started') {
      return 'started' as const;
    }
    if (phaseRaw === 'completed' || phaseRaw === 'done' || phaseRaw === 'finished' || phaseRaw === 'end') {
      return 'completed' as const;
    }
    if (phaseRaw === 'error' || phaseRaw === 'failed') {
      return 'error' as const;
    }
    if (phaseRaw === 'aborted' || phaseRaw === 'abort' || phaseRaw === 'cancelled' || phaseRaw === 'canceled') {
      return 'aborted' as const;
    }
    return null;
  })();
  if (!phase) {
    return null;
  }

  const runId = getTrimmedString(input.runId ?? data.runId);
  const sessionKey = getTrimmedString(input.sessionKey ?? data.sessionKey);
  return {
    phase,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

export function __resetGatewayChatEventDedupStateForTest(): void {
  recentNormalizedChatEvents.clear();
  agentEmbeddedMessageWarnCount = 0;
}

export function dispatchGatewayProtocolEvent(
  dispatcher: GatewayProtocolEventDispatcher,
  event: string,
  payload: unknown,
): void {
  switch (event) {
    case 'tick':
      break;
    case 'chat':
      {
        const normalized = normalizeGatewayChatEvent(payload);
        if (!normalized) {
          break;
        }
        if (isDuplicateNormalizedChatEvent(normalized)) {
          break;
        }
        dispatcher.emitConversationEvent({
          type: 'chat.message',
          event: normalized,
        });
      }
      break;
    case 'agent': {
      const input = asRecord(payload) ?? {};
      const data = asRecord(input.data) ?? {};
      const embeddedMessage = input.message ?? data.message;
      if (embeddedMessage != null && agentEmbeddedMessageWarnCount < AGENT_EMBEDDED_MESSAGE_WARN_LIMIT) {
        agentEmbeddedMessageWarnCount += 1;
        gatewayProtocolLogger.warn(
          'agent event contained embedded message but conversation stream treats agent as lifecycle-only',
          {
            runId: input.runId ?? data.runId,
            sessionKey: input.sessionKey ?? data.sessionKey,
            phase: data.phase ?? input.phase ?? data.state ?? input.state,
          },
        );
        if (agentEmbeddedMessageWarnCount === AGENT_EMBEDDED_MESSAGE_WARN_LIMIT) {
          gatewayProtocolLogger.warn(
            'suppressing further embedded-agent-message warnings after limit',
            { limit: AGENT_EMBEDDED_MESSAGE_WARN_LIMIT },
          );
        }
      }
      const runPhase = normalizeGatewayRunPhase(payload);
      if (runPhase) {
        dispatcher.emitConversationEvent({
          type: 'run.phase',
          ...runPhase,
        });
      }
      dispatcher.emitNotification({
        method: event,
        params: payload,
      } satisfies GatewayNotification);
      break;
    }
    case 'channel.status':
      dispatcher.emitChannelStatus(payload as { channelId: string; status: string });
      break;
    default:
      dispatcher.emitNotification({
        method: event,
        params: payload,
      } satisfies GatewayNotification);
  }
}
