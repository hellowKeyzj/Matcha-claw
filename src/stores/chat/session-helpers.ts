import type { ChatSession, ChatStoreState, TaskInboxChatBridgeState } from './types';

function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
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
  state: Pick<ChatStoreState, 'currentSessionKey' | 'sending' | 'pendingFinal' | 'activeRunId'>,
  defaultSessionKey: string,
): TaskInboxChatBridgeState {
  const sessionKey = normalizeTaskInboxSessionKey(state.currentSessionKey, defaultSessionKey);
  return {
    sessionKey,
    owner: parseAgentIdFromSessionKey(sessionKey) || 'main',
    canSendRecoveryPrompt: !state.sending && !state.pendingFinal && !state.activeRunId,
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
  sessionLastActivity: Record<string, number>,
): number {
  const fromStore = sessionLastActivity[session.key];
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
  sessionLastActivity: Record<string, number>,
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
    const leftActivity = resolveSessionActivityMs(left, sessionLastActivity);
    const rightActivity = resolveSessionActivityMs(right, sessionLastActivity);
    if (leftActivity !== rightActivity) {
      return rightActivity - leftActivity;
    }
    return left.key.localeCompare(right.key);
  });
  return sorted[0]?.key ?? null;
}

export function shouldKeepMissingCurrentSession(
  sessionKey: string,
  state: Pick<ChatStoreState, 'messages' | 'sessionLabels' | 'sessionLastActivity' | 'sessionRuntimeByKey'>,
  backendSessionCount: number,
): boolean {
  if (!sessionKey) {
    return false;
  }
  if (backendSessionCount === 0) {
    return true;
  }
  const hasMessages = state.messages.length > 0;
  const hasLabel = Boolean(state.sessionLabels[sessionKey]);
  const hasActivity = Boolean(state.sessionLastActivity[sessionKey]);
  const hasRuntime = Object.prototype.hasOwnProperty.call(state.sessionRuntimeByKey, sessionKey);
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
  state: Pick<ChatStoreState, 'messages' | 'sessionLastActivity' | 'sessionLabels'>,
): boolean {
  return !currentSessionKey.endsWith(':main')
    && state.messages.length === 0
    && !state.sessionLastActivity[currentSessionKey]
    && !state.sessionLabels[currentSessionKey];
}

