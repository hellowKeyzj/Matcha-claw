import { resolveSessionActivityMs } from '@/plugins/chat/session-catalog';
import type { ChatSession, ChatStoreState, TaskChatBridgeState } from '@/plugins/chat/store/types';
import { isOrdinarySessionCandidate, isRunActive } from '@/plugins/chat/store/types';
import {
  getSessionMeta,
  getSessionItemCount,
  getSessionRecord,
  getSessionRuntime,
  toMs,
} from '@/plugins/chat/store/store-state-helpers';

export interface SessionCatalogStatusShell {
  sessionsLoading: boolean;
  sessionsLoadedOnce: boolean;
  sessionsError: string | null;
}

export function readSessionCatalogStatusShell(
  state: Pick<ChatStoreState, 'sessionCatalogStatus'>,
): SessionCatalogStatusShell {
  return {
    sessionsLoading: state.sessionCatalogStatus.status === 'loading',
    sessionsLoadedOnce: state.sessionCatalogStatus.hasLoadedOnce,
    sessionsError: state.sessionCatalogStatus.error,
  };
}

export function hasSessionCatalogLoaded(
  state: Pick<ChatStoreState, 'sessionCatalogStatus'>,
): boolean {
  return readSessionCatalogStatusShell(state).sessionsLoadedOnce;
}

export function shouldRetainLocalSessionRecord(
  sessionKey: string,
  state: Pick<ChatStoreState, 'currentSessionKey' | 'loadedSessions' | 'pendingApprovalsBySession'>,
): boolean {
  if (!sessionKey) {
    return false;
  }
  if (state.currentSessionKey === sessionKey) {
    return true;
  }
  const record = getSessionRecord(state, sessionKey);
  if (record.meta.ownership?.kind === 'team') {
    return true;
  }
  const runtime = getSessionRuntime(state, sessionKey);
  return (
    getSessionItemCount(record) > 0
    || Boolean(record.meta.label)
    || Boolean(record.meta.lastActivityAt)
    || isRunActive(runtime)
    || runtime.activeRunId != null
    || runtime.activeTurnItemKey != null
    || (state.pendingApprovalsBySession[sessionKey]?.length ?? 0) > 0
  );
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
  const candidate = preferredSessionKey && preferredSessionKey.trim()
    ? preferredSessionKey
    : sessions[0]?.key;
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

export function normalizeTaskSessionKey(sessionKey: string | undefined, fallback: string): string {
  const normalized = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (normalized.length > 0) {
    return normalized;
  }
  const fallbackNormalized = fallback.trim();
  return fallbackNormalized || fallback;
}

export function buildTaskBridgeState(
  state: Pick<ChatStoreState, 'currentSessionKey' | 'loadedSessions'>,
  defaultSessionKey: string,
): TaskChatBridgeState {
  const sessionKey = normalizeTaskSessionKey(state.currentSessionKey, defaultSessionKey);
  const runtime = getSessionRuntime(state, sessionKey);
  const meta = getSessionMeta(state, sessionKey);
  return {
    sessionKey,
    owner: meta.agentId ?? meta.sessionIdentity?.agentId ?? 'main',
    canSendRecoveryPrompt: !isRunActive(runtime) && !runtime.activeRunId,
  };
}

export function resolvePreferredSessionKeyForAgent(
  agentId: string,
  sessions: ChatSession[],
  loadedSessions: ChatStoreState['loadedSessions'],
): string | null {
  const owned = sessions.filter((session) => session.agentId === agentId && isOrdinarySessionCandidate(session));
  if (owned.length === 0) {
    return null;
  }
  const preferred = owned.find((session) => session.preferred);
  if (preferred) {
    return preferred.key;
  }
  const sorted = [...owned].sort((left, right) => {
    const leftActivity = resolveSessionActivityMs(left, loadedSessions);
    const rightActivity = resolveSessionActivityMs(right, loadedSessions);
    if (leftActivity !== rightActivity) {
      return rightActivity - leftActivity;
    }
    return left.key.localeCompare(right.key);
  });
  return sorted[0]?.key ?? null;
}

export function shouldKeepMissingCurrentSession(
  sessionKey: string,
  state: Pick<ChatStoreState, 'loadedSessions'>,
  backendSessionCount: number,
): boolean {
  if (!sessionKey) {
    return false;
  }
  if (backendSessionCount === 0) {
    return true;
  }
  const record = getSessionRecord(state, sessionKey);
  const hasItems = getSessionItemCount(record) > 0;
  const hasLabel = Boolean(record.meta.label);
  const hasActivity = Boolean(record.meta.lastActivityAt);
  const hasRuntime = Object.prototype.hasOwnProperty.call(state.loadedSessions, sessionKey);
  const isPrimary = record.meta.preferred || record.meta.kind === 'main' || sessionKey.endsWith(':main');
  if (!isPrimary) {
    // Keep only local draft sessions (created but still truly empty).
    return !hasItems && !hasLabel && !hasActivity && hasRuntime;
  }
  return hasItems || hasLabel || hasActivity;
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
  state: Pick<ChatStoreState, 'loadedSessions'>,
): boolean {
  const sessionKey = currentSessionKey.trim();
  if (!sessionKey) {
    return false;
  }
  const record = state.loadedSessions[sessionKey];
  if (!record) {
    return false;
  }
  return isOrdinarySessionCandidate(record.meta)
    && !record.meta.preferred
    && record.meta.kind !== 'main'
    && !sessionKey.endsWith(':main')
    && getSessionItemCount(record) === 0
    && !record.meta.lastActivityAt
    && !record.meta.label;
}
