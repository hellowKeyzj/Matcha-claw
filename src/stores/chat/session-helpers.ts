import type { SessionIdentity } from '../../types/desktop/runtime-address';
import type { ChatSession, ChatSessionMetaState, ChatSessionRecord, ChatStoreState, TaskChatBridgeState } from './types';
import { isControlledSessionRenderItem } from './session-render-projection';
import { isOrdinarySessionCandidate, isRunActive } from './types';
import {
  getSessionMeta,
  getSessionItemCount,
  getSessionRecord,
  getSessionRuntime,
  getSessionItems,
  toMs,
  areSessionModelStatesEquivalent,
  areSessionOwnershipsEquivalent,
} from './store-state-helpers';

const EMPTY_CHAT_SESSIONS: ChatSession[] = [];
const WORKING_DIRECTORY_TITLE_PREFIX = '[Working directory:';

let cachedReadSessionsResult: ChatSession[] = EMPTY_CHAT_SESSIONS;
type SessionInput = {
  identityValues: string[];
  values: unknown[];
  label: string | null;
  explicit: boolean;
  displayName: string | null | undefined;
  session: ChatSession;
  activity: number;
};
let cachedSessionInputs = new Map<string, SessionInput>();
let cachedSessionKeys: string[] = [];
const automaticTitleByItem = new WeakMap<object, string | null>();
let cachedSessionTitles: Record<string, string | null> = {};
let cachedTitleInputs = new Map<string, {
  label: string | null | undefined;
  explicit: boolean;
  displayName: string | null | undefined;
  normalizedLabel: string | null;
  normalizedDisplayName: string | null;
}>();

function normalizeSessionLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function stripAutomaticWorkingDirectoryTitlePrefix(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(WORKING_DIRECTORY_TITLE_PREFIX)) {
    return trimmed.length > 0 ? trimmed : null;
  }

  const envelopeEnd = trimmed.indexOf(']');
  if (envelopeEnd < 0) {
    return null;
  }

  const rest = trimmed.slice(envelopeEnd + 1).trim();
  if (!rest || rest === '…' || rest === '...') {
    return null;
  }
  return rest;
}

export function normalizeAutomaticSessionTitle(value: string | null | undefined): string | null {
  const normalized = normalizeSessionLabel(value);
  const title = normalized ? stripAutomaticWorkingDirectoryTitlePrefix(normalized) : null;
  return title?.startsWith('<team_run_context>') ? null : title;
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
  const meta = getSessionMeta(state, sessionKey);
  const explicit = meta.manualLabel === true || meta.titleSource === 'user'
    ? normalizeSessionLabel(meta.label ?? fallbackLabel)
    : null;
  if (explicit) {
    return explicit;
  }
  const automaticLabel = normalizeAutomaticSessionTitle(meta.label ?? fallbackLabel);
  if (automaticLabel) {
    return automaticLabel;
  }
  const displayName = normalizeAutomaticSessionTitle(meta.displayName);
  if (displayName && displayName !== sessionKey && displayName !== meta.sessionIdentity?.sessionKey) {
    return displayName;
  }
  return resolveLatestUserTitle(getSessionItems(state, sessionKey));
}

function resolveLatestUserTitle(items: ChatSessionRecord['items']): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'user-message') continue;
    // Only the existing owner-certified immutable items may be cached by reference.
    let title = isControlledSessionRenderItem(item) ? automaticTitleByItem.get(item) : undefined;
    if (title === undefined) {
      title = normalizeAutomaticSessionTitle(item.text);
      if (isControlledSessionRenderItem(item)) automaticTitleByItem.set(item, title);
    }
    if (title) return title;
  }
  return null;
}

/** Current directory titles only; values are re-read on every call, not trusted by container identity. */
export function readSessionTitlesFromState(state: Pick<ChatStoreState, 'loadedSessions'>): Record<string, string | null> {
  const keys = Object.keys(state.loadedSessions);
  const nextInputs = new Map<string, NonNullable<ReturnType<typeof cachedTitleInputs.get>>>();
  let titles = cachedSessionTitles;
  for (const key of keys) {
    const record = state.loadedSessions[key];
    const meta = record.meta;
    const label = meta.label;
    const explicit = meta.manualLabel === true || meta.titleSource === 'user';
    const displayName = meta.displayName;
    const previous = cachedTitleInputs.get(key);
    const normalizedLabel = previous && previous.label === label && previous.explicit === explicit
      ? previous.normalizedLabel : explicit ? normalizeSessionLabel(label) : normalizeAutomaticSessionTitle(label);
    const normalizedDisplayName = previous && previous.displayName === displayName
      ? previous.normalizedDisplayName : normalizeAutomaticSessionTitle(displayName);
    const title = normalizedLabel || (normalizedDisplayName && normalizedDisplayName !== key
      && normalizedDisplayName !== meta.sessionIdentity?.sessionKey ? normalizedDisplayName : null)
      || resolveLatestUserTitle(record.items);
    nextInputs.set(key, previous && previous.label === label && previous.explicit === explicit && previous.displayName === displayName
      ? previous : { label, explicit, displayName, normalizedLabel, normalizedDisplayName });
    if (!Object.hasOwn(titles, key) || titles[key] !== title) {
      if (titles === cachedSessionTitles) titles = { ...titles };
      titles[key] = title;
    }
  }
  for (const key of Object.keys(titles)) {
    if (Object.hasOwn(state.loadedSessions, key)) continue;
    if (titles === cachedSessionTitles) titles = { ...titles };
    delete titles[key];
  }
  cachedTitleInputs = nextInputs;
  cachedSessionTitles = titles;
  return titles;
}

function sessionIdentityValues(identity: SessionIdentity): string[] {
  const endpoint = identity.endpoint;
  return [identity.agentId, identity.sessionKey, endpoint.kind,
    ...(endpoint.kind === 'native-runtime' ? [endpoint.runtimeAdapterId, endpoint.runtimeInstanceId]
      : [endpoint.protocolId, endpoint.connectorId, endpoint.endpointId])];
}

function sessionInputValues(meta: ChatSessionMetaState, context: ChatSessionRecord['contextTokens']): unknown[] {
  const ownership = meta.ownership;
  const model = meta.modelState;
  return [
    meta.endpointSessionId ?? null, meta.agentId ?? meta.sessionIdentity!.agentId, meta.protocolId ?? null, meta.runtimeEndpointId ?? null,
    ownership?.kind ?? null, ...(ownership?.kind === 'team' ? [ownership.teamId, ownership.teamRunId, ownership.roleId, ownership.sessionRef] : []),
    meta.kind ?? null, meta.preferred ?? false, meta.titleSource ?? null, meta.thinkingLevel ?? null,
    model?.overrideSource ?? null, model?.selectionId ?? null,
    model?.selected?.provider ?? null, model?.selected?.model ?? null, model?.selected?.ref ?? null,
    model?.active?.provider ?? null, model?.active?.model ?? null, model?.active?.ref ?? null,
    context?.totalTokens ?? null, context?.totalTokensFresh ?? null, context?.contextTokens ?? null, meta.lastActivityAt ?? null,
  ];
}

/** One current directory result. Read primitive dependencies each time; only changed rows materialize.
 * Ordering depends on membership/activity/key, never label or transcript container identity. */
export function readSessionsFromState(state: Pick<ChatStoreState, 'loadedSessions'>): ChatSession[] {
  const nextInputs = new Map<string, SessionInput>();
  const keys = Object.keys(state.loadedSessions).filter((key) => key && state.loadedSessions[key].meta.sessionIdentity);
  let orderChanged = keys.length !== cachedSessionKeys.length || keys.some((key, index) => key !== cachedSessionKeys[index]);
  let changed = orderChanged;
  for (const sessionKey of keys) {
    if (!sessionKey) continue;
    const record = state.loadedSessions[sessionKey];
    const meta = record.meta;
    if (!meta.sessionIdentity) continue;
    const identityValues = sessionIdentityValues(meta.sessionIdentity);
    const values = sessionInputValues(meta, record.contextTokens);
    const previous = cachedSessionInputs.get(sessionKey);
    const sameIdentity = previous && identityValues.length === previous.identityValues.length
      && identityValues.every((value, index) => value === previous.identityValues[index]);
    const rawLabel = meta.label;
    const explicit = meta.manualLabel === true || meta.titleSource === 'user';
    const displayName = meta.displayName;
    const sameValues = previous && values.length === previous.values.length && values.every((value, index) => Object.is(value, previous.values[index]));
    if (sameIdentity && sameValues && previous.label === rawLabel && previous.explicit === explicit && previous.displayName === displayName) {
      nextInputs.set(sessionKey, previous);
      continue;
    }
    const label = explicit ? normalizeSessionLabel(rawLabel) : normalizeAutomaticSessionTitle(rawLabel);
    const session: ChatSession = {
      key: sessionKey,
      ...(meta.endpointSessionId ? { endpointSessionId: meta.endpointSessionId } : {}),
      agentId: meta.agentId ?? meta.sessionIdentity.agentId,
      protocolId: meta.protocolId ?? undefined,
      runtimeEndpointId: meta.runtimeEndpointId ?? undefined,
      sessionIdentity: meta.sessionIdentity,
      ownership: meta.ownership,
      kind: meta.kind ?? undefined,
      preferred: meta.preferred,
      label: label ?? undefined,
      titleSource: meta.titleSource,
      displayName: normalizeAutomaticSessionTitle(meta.displayName) ?? sessionKey,
      thinkingLevel: meta.thinkingLevel ?? undefined,
      modelState: meta.modelState ?? undefined,
      contextTokens: record.contextTokens,
      updatedAt: typeof meta.lastActivityAt === 'number' ? meta.lastActivityAt : undefined,
    };
    const activity = resolveSessionActivityMs(session, state.loadedSessions);
    const sameSession = sameIdentity && previous.session.endpointSessionId === session.endpointSessionId
      && previous.session.agentId === session.agentId && previous.session.protocolId === session.protocolId
      && previous.session.runtimeEndpointId === session.runtimeEndpointId
      && areSessionOwnershipsEquivalent(previous.session.ownership, session.ownership)
      && previous.session.kind === session.kind && (previous.session.preferred ?? false) === (session.preferred ?? false)
      && previous.session.label === session.label && (previous.session.titleSource ?? null) === (session.titleSource ?? null)
      && previous.session.displayName === session.displayName && previous.session.thinkingLevel === session.thinkingLevel
      && areSessionModelStatesEquivalent(previous.session.modelState, session.modelState)
      && (previous.session.contextTokens?.totalTokens ?? null) === (session.contextTokens?.totalTokens ?? null)
      && (previous.session.contextTokens?.totalTokensFresh ?? null) === (session.contextTokens?.totalTokensFresh ?? null)
      && (previous.session.contextTokens?.contextTokens ?? null) === (session.contextTokens?.contextTokens ?? null)
      && (previous.session.updatedAt ?? null) === (session.updatedAt ?? null);
    nextInputs.set(sessionKey, { identityValues, values, label: rawLabel, explicit, displayName, session: sameSession ? previous.session : session, activity });
    if (!sameSession) changed = true;
    if (!previous || previous.activity !== activity) orderChanged = true;
  }
  if (nextInputs.size !== cachedSessionInputs.size) {
    changed = true;
    orderChanged = true;
  }
  if (changed) {
    const sessions = orderChanged ? Array.from(nextInputs.values(), (entry) => entry.session).sort((left, right) => (
      nextInputs.get(right.key)!.activity - nextInputs.get(left.key)!.activity || left.key.localeCompare(right.key)
    )) : cachedReadSessionsResult.map((session) => nextInputs.get(session.key)!.session);
    if (sessions.length !== cachedReadSessionsResult.length
      || sessions.some((session, index) => session !== cachedReadSessionsResult[index])) {
      cachedReadSessionsResult = sessions.length ? sessions : EMPTY_CHAT_SESSIONS;
    }
  }
  cachedSessionInputs = nextInputs;
  cachedSessionKeys = keys;
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

export function parseSessionCreatedAtMs(sessionKey: string): number | null {
  const matched = sessionKey.match(/(?:^|:)session-(\d{11,})(?=$|:)/);
  if (!matched) {
    return null;
  }
  const createdAtMs = Number(matched[1]);
  return Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : null;
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
  return parseSessionCreatedAtMs(session.sessionIdentity.sessionKey) ?? 0;
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
