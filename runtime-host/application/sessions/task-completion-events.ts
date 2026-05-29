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
  const kind = normalizeOptionalString(record.kind)?.toLowerCase();
  if (kind !== 'task_completion') {
    return null;
  }
  const childSessionKey = normalizeOptionalString(record.childSessionKey);
  if (!childSessionKey) {
    return null;
  }
  const childSessionId = normalizeOptionalString(record.childSessionId);
  const childAgentId = normalizeOptionalString(record.childAgentId) ?? resolveChildAgentId(childSessionKey);
  return {
    kind: 'task_completion',
    source: normalizeCompletionSource(record.source),
    childSessionKey,
    ...(childSessionId ? { childSessionId } : {}),
    ...(childAgentId ? { childAgentId } : {}),
    ...(normalizeOptionalString(record.announceType) ? { announceType: normalizeOptionalString(record.announceType)! } : {}),
    ...(normalizeOptionalString(record.taskLabel) ? { taskLabel: normalizeOptionalString(record.taskLabel)! } : {}),
    ...(normalizeOptionalString(record.statusLabel) ? { statusLabel: normalizeOptionalString(record.statusLabel)! } : {}),
    ...(normalizeOptionalString(record.result) ? { result: normalizeOptionalString(record.result)! } : {}),
    ...(normalizeOptionalString(record.statsLine) ? { statsLine: normalizeOptionalString(record.statsLine)! } : {}),
    ...(normalizeOptionalString(record.replyInstruction) ? { replyInstruction: normalizeOptionalString(record.replyInstruction)! } : {}),
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

export function normalizeTaskCompletionEvents(events: unknown): SessionTaskCompletionEvent[] | undefined {
  const explicitEvents = (Array.isArray(events) ? events : [])
    .map((item) => normalizeTaskCompletionEventRecord(item))
    .filter((item): item is SessionTaskCompletionEvent => Boolean(item));
  return explicitEvents.length > 0 ? dedupeTaskCompletionEvents(explicitEvents) : undefined;
}
