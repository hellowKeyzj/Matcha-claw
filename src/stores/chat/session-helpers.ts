import type { ChatSession, ChatStoreState, TaskInboxChatBridgeState } from './types';
import { resolveSessionLabelFromMessages } from './message-helpers';
import {
  getSessionMeta,
  getSessionMessages,
  getSessionRecord,
  getSessionRuntime,
  toMs,
} from './store-state-helpers';

const EMPTY_CHAT_SESSIONS: ChatSession[] = [];

let cachedReadSessionsLoadedSessions: ChatStoreState['loadedSessions'] | null = null;
let cachedReadSessionsResult: ChatSession[] = EMPTY_CHAT_SESSIONS;
let cachedReadSessionsByKey = new Map<string, ChatSession>();

function normalizeSessionLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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

export function resolveSessionListLabel(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  fallbackLabel?: string | null,
): string | null {
  const runtime = getSessionRuntime(state, sessionKey);
  const pendingUserLabel = runtime.pendingUserMessage
    ? resolveSessionLabelFromMessages([runtime.pendingUserMessage.message])
    : null;
  if (pendingUserLabel) {
    return pendingUserLabel;
  }

  const viewportMessages = getSessionMessages(state, sessionKey);
  if (viewportMessages.length > 0) {
    const viewportLabel = resolveSessionLabelFromMessages(viewportMessages);
    if (viewportLabel) {
      return viewportLabel;
    }
  }

  return normalizeSessionLabel(getSessionMeta(state, sessionKey).label ?? fallbackLabel);
}

function areChatSessionsEqual(left: ChatSession | undefined, right: ChatSession): boolean {
  if (!left) {
    return false;
  }
  return (
    left.key === right.key
    && (left.label ?? null) === (right.label ?? null)
    && (left.displayName ?? null) === (right.displayName ?? null)
    && (left.thinkingLevel ?? null) === (right.thinkingLevel ?? null)
    && (left.model ?? null) === (right.model ?? null)
    && (left.updatedAt ?? null) === (right.updatedAt ?? null)
  );
}

function reuseChatSession(previous: ChatSession | undefined, next: ChatSession): ChatSession {
  if (areChatSessionsEqual(previous, next)) {
    return previous!;
  }
  return next;
}

export function readSessionsFromState(
  state: Pick<ChatStoreState, 'loadedSessions'>,
): ChatSession[] {
  if (cachedReadSessionsLoadedSessions === state.loadedSessions) {
    return cachedReadSessionsResult;
  }

  const mergedSessionsByKey = new Map<string, ChatSession>();

  for (const sessionKey of Object.keys(state.loadedSessions)) {
    if (!sessionKey) {
      continue;
    }
    const meta = getSessionMeta(state, sessionKey);
    const label = resolveSessionListLabel(state, sessionKey, null);
    const nextSession = {
      key: sessionKey,
      label: label ?? undefined,
      displayName: normalizeSessionLabel(meta.displayName) ?? sessionKey,
      thinkingLevel: meta.thinkingLevel ?? undefined,
      model: normalizeSessionLabel(meta.model) ?? undefined,
      updatedAt: typeof meta.lastActivityAt === 'number' ? meta.lastActivityAt : undefined,
    } satisfies ChatSession;
    mergedSessionsByKey.set(sessionKey, reuseChatSession(cachedReadSessionsByKey.get(sessionKey), nextSession));
  }

  const nextSessions = Array.from(mergedSessionsByKey.values()).sort((left, right) => {
    const leftActivity = resolveSessionActivityMs(left, state.loadedSessions);
    const rightActivity = resolveSessionActivityMs(right, state.loadedSessions);
    if (leftActivity !== rightActivity) {
      return rightActivity - leftActivity;
    }
    return left.key.localeCompare(right.key);
  });

  let nextResult = nextSessions;
  if (
    cachedReadSessionsResult.length === nextSessions.length
    && nextSessions.every((session, index) => cachedReadSessionsResult[index] === session)
  ) {
    nextResult = cachedReadSessionsResult;
  }

  cachedReadSessionsLoadedSessions = state.loadedSessions;
  cachedReadSessionsResult = nextResult.length > 0 ? nextResult : EMPTY_CHAT_SESSIONS;
  cachedReadSessionsByKey = mergedSessionsByKey;
  return cachedReadSessionsResult;
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
  const runtime = record.runtime;
  return (
    record.window.messages.length > 0
    || Boolean(record.meta.label)
    || Boolean(record.meta.lastActivityAt)
    || runtime.pendingUserMessage != null
    || runtime.sending
    || runtime.pendingFinal
    || runtime.activeRunId != null
    || runtime.streamingMessageId != null
    || runtime.approvalStatus === 'awaiting_approval'
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
  state: Pick<ChatStoreState, 'currentSessionKey' | 'loadedSessions'>,
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
  loadedSessions: ChatStoreState['loadedSessions'],
): number {
  const fromStore = getSessionMeta({ loadedSessions }, session.key).lastActivityAt;
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
  loadedSessions: ChatStoreState['loadedSessions'],
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
  const hasMessages = record.window.messages.length > 0;
  const hasLabel = Boolean(record.meta.label);
  const hasActivity = Boolean(record.meta.lastActivityAt);
  const hasRuntime = Object.prototype.hasOwnProperty.call(state.loadedSessions, sessionKey);
  if (!sessionKey.endsWith(':main')) {
    // Keep only local draft sessions (created but still truly empty).
    return !hasMessages && !hasLabel && !hasActivity && hasRuntime;
  }
  return hasMessages || hasLabel || hasActivity;
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
  const messages = getSessionMessages(state, currentSessionKey);
  const record = getSessionRecord(state, currentSessionKey);
  return !currentSessionKey.endsWith(':main')
    && messages.length === 0
    && !record.meta.lastActivityAt
    && !record.meta.label;
}
