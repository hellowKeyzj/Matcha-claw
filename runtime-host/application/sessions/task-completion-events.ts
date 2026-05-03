import { normalizeOptionalString } from '../../shared/chat-message-normalization';
import type { SessionTaskCompletionEvent } from '../../shared/session-adapter-types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCompletionSource(value: unknown): SessionTaskCompletionEvent['source'] {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === 'subagent' || normalized === 'cron') {
    return normalized;
  }
  return 'unknown';
}

function resolveChildAgentId(childSessionKey: string): string | undefined {
  const match = childSessionKey.match(/^agent:([^:]+):/i);
  return normalizeOptionalString(match?.[1]);
}

function normalizeTaskCompletionEventRecord(
  value: unknown,
): SessionTaskCompletionEvent | null {
  const record = isRecord(value) ? value : null;
  if (!record) {
    return null;
  }
  const kind = normalizeOptionalString(record.kind ?? record.type)?.toLowerCase();
  if (kind !== 'task_completion') {
    return null;
  }
  const childSessionKey = normalizeOptionalString(
    record.childSessionKey
    ?? record.sessionKey
    ?? record.child_session_key
    ?? record.session_key,
  );
  if (!childSessionKey) {
    return null;
  }
  const childSessionId = normalizeOptionalString(
    record.childSessionId
    ?? record.sessionId
    ?? record.child_session_id
    ?? record.session_id,
  );
  const childAgentId = normalizeOptionalString(
    record.childAgentId
    ?? record.agentId
    ?? record.child_agent_id
    ?? record.agent_id,
  ) ?? resolveChildAgentId(childSessionKey);
  return {
    kind: 'task_completion',
    source: normalizeCompletionSource(record.source),
    childSessionKey,
    ...(childSessionId ? { childSessionId } : {}),
    ...(childAgentId ? { childAgentId } : {}),
    ...(normalizeOptionalString(record.announceType ?? record.announce_type)
      ? { announceType: normalizeOptionalString(record.announceType ?? record.announce_type)! }
      : {}),
    ...(normalizeOptionalString(record.taskLabel ?? record.task ?? record.task_label)
      ? { taskLabel: normalizeOptionalString(record.taskLabel ?? record.task ?? record.task_label)! }
      : {}),
    ...(normalizeOptionalString(record.statusLabel ?? record.status_label)
      ? { statusLabel: normalizeOptionalString(record.statusLabel ?? record.status_label)! }
      : {}),
    ...(normalizeOptionalString(record.result) ? { result: normalizeOptionalString(record.result)! } : {}),
    ...(normalizeOptionalString(record.statsLine ?? record.stats_line)
      ? { statsLine: normalizeOptionalString(record.statsLine ?? record.stats_line)! }
      : {}),
    ...(normalizeOptionalString(record.replyInstruction ?? record.reply_instruction)
      ? { replyInstruction: normalizeOptionalString(record.replyInstruction ?? record.reply_instruction)! }
      : {}),
  };
}

function dedupeTaskCompletionEvents(
  events: SessionTaskCompletionEvent[],
): SessionTaskCompletionEvent[] {
  const deduped: SessionTaskCompletionEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const key = [
      event.childSessionKey,
      event.childSessionId ?? '',
      event.childAgentId ?? '',
      event.announceType ?? '',
      event.taskLabel ?? '',
      event.statusLabel ?? '',
    ].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

export function normalizeTaskCompletionEvents(input: {
  taskCompletionEvents?: unknown;
  internalEvents?: unknown;
}): SessionTaskCompletionEvent[] | undefined {
  const explicitEvents = [
    ...(Array.isArray(input.taskCompletionEvents) ? input.taskCompletionEvents : []),
    ...(Array.isArray(input.internalEvents) ? input.internalEvents : []),
  ]
    .map((item) => normalizeTaskCompletionEventRecord(item))
    .filter((item): item is SessionTaskCompletionEvent => Boolean(item));
  return explicitEvents.length > 0 ? dedupeTaskCompletionEvents(explicitEvents) : undefined;
}
