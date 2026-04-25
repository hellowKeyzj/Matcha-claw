import type { ChatSession, ChatStoreState, TaskInboxChatBridgeState } from './types';
import {
  getSessionMeta,
  getSessionRecord,
  getSessionRuntime,
  toMs,
} from './store-state-helpers';

export function readSessionsFromState(
  state: Pick<ChatStoreState, 'sessionsResource'> & { sessions?: ChatSession[] },
): ChatSession[] {
  if (Array.isArray(state.sessionsResource.data)) {
    return state.sessionsResource.data;
  }
  return Array.isArray(state.sessions) ? state.sessions : [];
}

export function resolveSessionThinkingLevelFromList(
  sessions: ChatSession[],
  sessionKey: string,
): string | null {
  const found = sessions.find((session) => session.key === sessionKey);
  if (!found || typeof found.thinkingLevel !== 'string') return null;
  const normalized = found.thinkingLevel.trim();
  return normalized || null;
}

export function getCanonicalPrefixFromSessions(
  sessions: ChatSession[],
  preferredSessionKey?: string,
): string | null {
  const candidate = preferredSessionKey && preferredSessionKey.startsWith('agent:')
    ? preferredSessionKey
    : sessions.find((s) => s.key.startsWith('agent:'))?.key;
  if (!candidate) return null;
  const parts = candidate.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

export function resolveCanonicalPrefixForAgent(agentId?: string): string | null {
  if (typeof agentId !== 'string') {
    return null;
  }
  const normalized = agentId.trim();
  if (!normalized) {
    return null;
  }
  return `agent:${normalized}`;
}

export function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

export function normalizeTaskInboxSessionKey(sessionKey: string | undefined, fallback: string): string {
  const normalized = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (normalized.length > 0) {
    return normalized;
  }
  const fallbackNormalized = fallback.trim();
  return fallbackNormalized || fallback;
}

export function buildTaskInboxBridgeState(
  state: Pick<ChatStoreState, 'currentSessionKey' | 'sessionsByKey'>,
  defaultSessionKey: string,
): TaskInboxChatBridgeState {
  const sessionKey = normalizeTaskInboxSessionKey(state.currentSessionKey, defaultSessionKey);
  const runtime = getSessionRuntime(state, sessionKey);
  return {
    sessionKey,
    owner: parseAgentIdFromSessionKey(sessionKey) || 'main',
    canSendRecoveryPrompt: !runtime.sending && !runtime.pendingFinal && !runtime.activeRunId,
  };
}

export function parseSessionTimestampMs(sessionKey: string): number | null {
  const suffix = sessionKey.split(':').slice(2).join(':') || sessionKey;
  const matched = suffix.match(/session-(\d{8,16})/i);
  if (!matched) return null;
  const raw = Number(matched[1]);
  if (!Number.isFinite(raw)) return null;
  return matched[1].length <= 10 ? raw * 1000 : raw;
}

export function resolveSessionActivityMs(
  session: ChatSession,
  sessionsByKey: ChatStoreState['sessionsByKey'],
): number {
  const fromStore = getSessionMeta({ sessionsByKey }, session.key).lastActivityAt;
  if (typeof fromStore === 'number' && Number.isFinite(fromStore)) {
    return fromStore;
  }
  if (typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)) {
    return session.updatedAt;
  }
  return parseSessionTimestampMs(session.key) ?? 0;
}

export function resolvePreferredSessionKeyForAgent(
  agentId: string,
  sessions: ChatSession[],
  sessionsByKey: ChatStoreState['sessionsByKey'],
): string | null {
  const canonicalKey = `agent:${agentId}:main`;
  const owned = sessions.filter((session) => parseAgentIdFromSessionKey(session.key) === agentId);
  if (owned.length === 0) {
    return null;
  }
  if (owned.some((session) => session.key === canonicalKey)) {
    return canonicalKey;
  }
  const sorted = [...owned].sort((left, right) => {
    const leftActivity = resolveSessionActivityMs(left, sessionsByKey);
    const rightActivity = resolveSessionActivityMs(right, sessionsByKey);
    if (leftActivity !== rightActivity) {
      return rightActivity - leftActivity;
    }
    return left.key.localeCompare(right.key);
  });
  return sorted[0]?.key ?? null;
}

export function shouldKeepMissingCurrentSession(
  sessionKey: string,
  state: Pick<ChatStoreState, 'sessionsByKey'>,
  backendSessionCount: number,
): boolean {
  if (!sessionKey) {
    return false;
  }
  if (backendSessionCount === 0) {
    return true;
  }
  const record = getSessionRecord(state, sessionKey);
  const hasMessages = record.transcript.length > 0;
  const hasLabel = Boolean(record.meta.label);
  const hasActivity = Boolean(record.meta.lastActivityAt);
  const hasRuntime = Object.prototype.hasOwnProperty.call(state.sessionsByKey, sessionKey);
  if (!sessionKey.endsWith(':main')) {
    // Keep only local draft sessions (created but still truly empty).
    return !hasMessages && !hasLabel && !hasActivity && !hasRuntime;
  }
  return hasMessages || hasLabel || hasActivity || hasRuntime;
}

export function parseSessionUpdatedAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toMs(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function isTrulyEmptyNonMainSession(
  currentSessionKey: string,
  state: Pick<ChatStoreState, 'sessionsByKey'>,
): boolean {
  const record = getSessionRecord(state, currentSessionKey);
  return !currentSessionKey.endsWith(':main')
    && record.transcript.length === 0
    && !record.meta.lastActivityAt
    && !record.meta.label;
}
