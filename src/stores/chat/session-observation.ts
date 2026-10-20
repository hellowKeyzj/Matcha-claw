import { observeChatSession, releaseChatSession } from '@/services/runtime/session-runtime';
import { isSessionTraceEnabled, logSessionTrace, summarizeError, summarizeIdentifier, summarizeSessionIdentity } from '@/lib/session-trace';
import { assertSessionIdentity, buildSessionIdentityKey, type SessionIdentity } from '../../types/desktop/runtime-address';
import type { SessionView } from '../../types/session/snapshot';
import { CHAT_HISTORY_FULL_LIMIT, CHAT_HISTORY_LOADING_TIMEOUT_MS } from './history-constants';
import { executeHistoryLoad, type HistoryLoadExecutionDeps } from './history-load-execution';
import { findSessionRecordKey } from './session-identity';
import { buildCurrentConversationFromSessionRecord } from './session-runtime-graph';
import type { StoreSessionRunCache } from './session-run-cache';
import { applySessionView, getSessionMeta, patchSessionMeta } from './store-state-helpers';
import type { ChatStoreActions } from './types';

type SessionObservationDeps = Pick<HistoryLoadExecutionDeps, 'set' | 'get' | 'historyRuntime'> & {
  getSendGeneration: StoreSessionRunCache['getSendGeneration'];
};

type SessionObservationActions = Pick<ChatStoreActions, 'observeSession' | 'releaseSession' | 'resyncSession' | 'loadHistory'>;

type Observation = {
  identity: SessionIdentity;
  leaseId: string;
  requestSequence: number;
  request?: Promise<SessionView | null>;
  historyTask?: Promise<void>;
  watermark?: { epoch: number; seq: number };
};

export function createSessionObservation({ set, get, historyRuntime, getSendGeneration }: SessionObservationDeps): SessionObservationActions {
  const observations = new Map<string, Observation>();

  const releaseSession: SessionObservationActions['releaseSession'] = async (identity, leaseId) => {
    const key = buildSessionIdentityKey(identity);
    if (observations.get(key)?.leaseId === leaseId) observations.delete(key);
    await releaseChatSession({ sessionIdentity: identity, leaseId });
  };

  const observeHistory: NonNullable<HistoryLoadExecutionDeps['observeHistory']> = (identity, options) => {
    const observation = observations.get(buildSessionIdentityKey(identity));
    if (!observation) return Promise.resolve(null);
    if (observation.request) return observation.request;
    const key = buildSessionIdentityKey(identity);
    const recordKey = findSessionRecordKey(get(), identity);
    const generation = recordKey ? getSendGeneration(recordKey) : null;
    const requestSequence = ++observation.requestSequence;
    const startedAt = isSessionTraceEnabled() ? performance.now() : null;
    const task = (async () => {
      if (isSessionTraceEnabled()) logSessionTrace('session.observe.request', options.traceId, () => ({
        identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(observation.leaseId).hash,
        requestSequence, generation, limit: CHAT_HISTORY_FULL_LIMIT,
      }));
      let result: Awaited<ReturnType<typeof observeChatSession>>;
      try {
        result = await observeChatSession({ sessionIdentity: identity, leaseId: observation.leaseId, limit: CHAT_HISTORY_FULL_LIMIT }, options);
      } catch (error) {
        if (isSessionTraceEnabled()) logSessionTrace('session.observe.error', options.traceId, () => ({
          identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(observation.leaseId).hash,
          requestSequence, requestElapsedMs: startedAt === null ? null : performance.now() - startedAt,
          current: observations.get(key) === observation, ...summarizeError(error),
        }));
        throw error;
      }
      if ('outcome' in result || observations.get(key) !== observation) {
        if (isSessionTraceEnabled()) logSessionTrace('session.observe.drop', options.traceId, () => ({
          identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(observation.leaseId).hash,
          requestSequence, requestElapsedMs: startedAt === null ? null : performance.now() - startedAt,
          reason: 'outcome' in result ? 'observation-released' : 'observation-replaced',
        }));
        if ('view' in result) await releaseChatSession({ sessionIdentity: identity, leaseId: observation.leaseId });
        return null;
      }
      if (isSessionTraceEnabled()) logSessionTrace('session.observe.response', options.traceId, () => ({
        identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(observation.leaseId).hash,
        requestSequence, requestElapsedMs: startedAt === null ? null : performance.now() - startedAt,
        epoch: result.view.epoch, seq: result.view.seq, cursor: result.view.cursor,
      }));
      return result.view;
    })();
    observation.request = task;
    void task.finally(() => { if (observation.request === task) observation.request = undefined; }).catch(() => undefined);
    return task;
  };

  const refreshObservation = async (identity: SessionIdentity, leaseId: string, cause: 'observe' | 'resync' = 'observe', watermark?: { epoch: number; seq: number }) => {
    const tracing = isSessionTraceEnabled();
    let requestElapsedMs: number | null = null;
    const trace = (stage: string, extra: Record<string, unknown> = {}) => {
      if (isSessionTraceEnabled()) logSessionTrace(stage, 'session-observation-boundary', () => ({
        identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(leaseId).hash, cause, requestedWatermark: watermark ?? null, requestElapsedMs, ...extra,
      }));
    };
    const identityKey = buildSessionIdentityKey(identity);
    const observation = observations.get(identityKey);
    if (!observation || observation.leaseId !== leaseId) { trace('session.observe.drop', { reason: 'lease-not-current' }); return; }
    const requestSequence = ++observation.requestSequence;
    const recordKey = findSessionRecordKey(get(), identity);
    if (!recordKey) { trace('session.observe.drop', { reason: 'record-not-found', requestSequence }); return; }
    const generation = getSendGeneration(recordKey);
    const recordIdentity = get().loadedSessions[recordKey]?.meta.sessionIdentity;
    const isCurrent = () => observations.get(identityKey) === observation
      && observation.requestSequence === requestSequence
      && get().loadedSessions[recordKey]?.meta.sessionIdentity === recordIdentity
      && getSendGeneration(recordKey) === generation;
    const dropReason = () => observations.get(identityKey) !== observation ? 'observation-replaced'
      : observation.requestSequence !== requestSequence ? 'request-superseded'
      : get().loadedSessions[recordKey]?.meta.sessionIdentity !== recordIdentity ? 'record-identity-changed' : 'send-generation-changed';
    if (isSessionTraceEnabled()) trace('session.observe.request', { requestSequence, generation, recordKey: summarizeIdentifier(recordKey) });
    const requestStartedAt = tracing ? performance.now() : 0;
    try {
      const observationResult = await observeChatSession({ sessionIdentity: identity, leaseId });
      requestElapsedMs = tracing ? performance.now() - requestStartedAt : null;
      if ('outcome' in observationResult) {
        trace('session.observe.drop', { requestSequence, generation, reason: 'observation-released' });
        return;
      }
      const { view } = observationResult;
      trace('session.observe.response', { requestSequence, generation, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
      if (observations.get(identityKey) !== observation) {
        trace('session.observe.drop', { requestSequence, reason: 'observation-replaced', epoch: view.epoch, seq: view.seq, cursor: view.cursor });
        await releaseChatSession({ sessionIdentity: identity, leaseId });
        return;
      }
      if (!isCurrent()) { trace('session.observe.drop', { requestSequence, reason: dropReason(), epoch: view.epoch, seq: view.seq, cursor: view.cursor }); return; }
      const applyStartedAt = tracing ? performance.now() : 0;
      const result = applySessionView({ set, get }, view);
      const applyElapsedMs = tracing ? performance.now() - applyStartedAt : null;
      if (isSessionTraceEnabled()) trace('session.observe.apply', { requestSequence, applyElapsedMs, status: result.status, reason: 'reason' in result ? summarizeIdentifier(result.reason) : null, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
      if ((result.status === 'applied' || result.status === 'duplicate')
        && view.items !== 'unknown' && view.items !== 'unavailable') {
        set((state) => ({ loadedSessions: patchSessionMeta(state, recordKey, { historyStatus: 'ready' }) }));
      }
    } catch (error) {
      if (tracing && requestElapsedMs === null) requestElapsedMs = performance.now() - requestStartedAt;
      if (isSessionTraceEnabled()) trace('session.observe.error', { requestSequence, current: isCurrent(), reason: isCurrent() ? null : dropReason(), ...summarizeError(error) });
      if (!isCurrent()) return;
      if (get().currentSessionKey === recordKey) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  };

  const loadHistory: SessionObservationActions['loadHistory'] = (request) => {
    const normalizedSessionKey = request.sessionKey.trim();
    if (!normalizedSessionKey) {
      return Promise.resolve();
    }
    const recordIdentity = get().loadedSessions[normalizedSessionKey]?.meta.sessionIdentity;
    const generation = getSendGeneration(normalizedSessionKey);
    const isOpenClaw = recordIdentity?.endpoint.kind === 'native-runtime' && recordIdentity.endpoint.runtimeAdapterId === 'openclaw';
    const observation = isOpenClaw ? observations.get(buildSessionIdentityKey(recordIdentity)) : undefined;
    if (isOpenClaw && !observation && request.reason === 'same_session_refresh') return Promise.resolve();
    if (observation?.historyTask) return observation.historyTask;
    const task = executeHistoryLoad({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: CHAT_HISTORY_LOADING_TIMEOUT_MS,
      ...(observation ? {
        observeHistory,
        isObservationCurrent: () => observations.get(buildSessionIdentityKey(recordIdentity!)) === observation
          && getSendGeneration(normalizedSessionKey) === generation,
        onObservedViewApplied: (view: SessionView) => {
          if (observations.get(buildSessionIdentityKey(view.identity)) === observation) observation.watermark = { epoch: view.epoch, seq: view.seq };
        },
      } : {}),
    }, {
      ...request,
      sessionKey: normalizedSessionKey,
    });
    if (observation) {
      observation.historyTask = task;
      void task.finally(() => { if (observation.historyTask === task) observation.historyTask = undefined; }).catch(() => undefined);
    }
    historyRuntime.setHistoryLoadInFlight(normalizedSessionKey, task);
    void task.then(
      () => {
        historyRuntime.clearHistoryLoadInFlight(normalizedSessionKey, task);
        if (get().loadedSessions[normalizedSessionKey]?.meta.sessionIdentity === recordIdentity) {
          set((state) => ({
            currentConversation: normalizedSessionKey === state.currentSessionKey && state.loadedSessions[normalizedSessionKey]
              ? buildCurrentConversationFromSessionRecord(state.loadedSessions[normalizedSessionKey]!, state.currentConversation)
              : state.currentConversation,
          }));
        }
      },
      () => historyRuntime.clearHistoryLoadInFlight(normalizedSessionKey, task),
    );
    return task;
  };

  return {
    observeSession: (identity, leaseId = crypto.randomUUID()) => {
      observations.set(buildSessionIdentityKey(identity), { identity, leaseId, requestSequence: 0 });
      if (identity.endpoint.kind !== 'native-runtime' || identity.endpoint.runtimeAdapterId !== 'openclaw') return { leaseId, ready: refreshObservation(identity, leaseId) };
      const recordKey = findSessionRecordKey(get(), identity);
      return { leaseId, ready: recordKey ? get().loadHistory({
        sessionKey: recordKey,
        mode: getSessionMeta(get(), recordKey).historyStatus === 'ready' || get().loadedSessions[recordKey]?.items.length ? 'quiet' : 'active',
        scope: get().currentSessionKey === recordKey ? 'foreground' : 'background',
        reason: 'chat_init_cold_start',
      }) : Promise.resolve() };
    },
    releaseSession,
    resyncSession: async (event) => {
      const drop = (reason: string) => { if (isSessionTraceEnabled()) logSessionTrace('session.resync.drop', 'session-resync-boundary', () => ({ reason })); };
      if (!event || typeof event !== 'object' || Array.isArray(event)) { drop('invalid-event-shape'); return; }
      const value = event as Record<string, unknown>;
      if (Object.keys(value).length !== 3
        || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1
        || !Number.isSafeInteger(value.seq) || (value.seq as number) < 0) { drop('invalid-watermark'); return; }
      try {
        assertSessionIdentity(value.identity);
      } catch {
        drop('invalid-identity');
        return;
      }
      const identity = value.identity;
      const observation = observations.get(buildSessionIdentityKey(identity));
      if (isSessionTraceEnabled()) logSessionTrace('session.resync.request', 'session-resync-boundary', () => ({
        identity: summarizeSessionIdentity(identity), epoch: value.epoch, seq: value.seq,
        accepted: !!observation, reason: observation ? null : 'no-active-observation',
      }));
      if (observation?.identity.endpoint.kind === 'native-runtime' && observation.identity.endpoint.runtimeAdapterId === 'openclaw') {
        const key = buildSessionIdentityKey(observation.identity);
        const covered = () => observation.watermark && (observation.watermark.epoch > (value.epoch as number)
          || observation.watermark.epoch === value.epoch && observation.watermark.seq >= (value.seq as number));
        if (observations.get(key) !== observation || covered()) return;
        const recordKey = findSessionRecordKey(get(), observation.identity);
        if (!recordKey) return;
        // Let the existing history apply finish before a later frontier supersedes it.
        while (observation.historyTask) {
          await observation.historyTask;
          if (observations.get(key) !== observation || covered()) return;
        }
        if (observations.get(key) !== observation || covered()) return;
        await get().loadHistory({ sessionKey: recordKey, mode: 'quiet',
          scope: get().currentSessionKey === recordKey ? 'foreground' : 'background', reason: 'session_resync' });
      } else if (observation) await refreshObservation(observation.identity, observation.leaseId, 'resync', { epoch: value.epoch as number, seq: value.seq as number });
    },
    loadHistory,
  };
}
