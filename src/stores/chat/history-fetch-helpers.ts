import { hostApiFetch } from '@/lib/host-api';
import { trackUiTiming } from '@/lib/telemetry';
import { useGatewayStore } from '../gateway';
import { buildCronSessionHistoryPath, isCronSessionKey } from './cron-session-utils';
import { resolveSessionThinkingLevelFromList } from './session-helpers';
import {
  buildHistoryFingerprint,
  buildQuickRawHistoryFingerprint,
  nowMs,
} from './store-state-helpers';
import {
  isHistoryLoadAbortError,
  throwIfHistoryLoadAborted,
} from './history-abort';
import type { StoreHistoryCache } from './history-cache';
import type {
  ChatHistoryLoadScope,
  ChatSession,
  ChatStoreState,
  RawMessage,
} from './types';

export const CHAT_HISTORY_FULL_LIMIT = 200;
export const CHAT_HISTORY_ACTIVE_PROBE_LIMIT = 10;
export const CHAT_HISTORY_QUIET_PROBE_LIMIT = 64;
export const CHAT_HISTORY_QUIET_FULL_LIMIT = 120;
export const CHAT_HISTORY_LOADING_TIMEOUT_MS = 15_000;

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export interface HistoryWindowResult {
  rawMessages: RawMessage[];
  thinkingLevel: string | null;
}

interface CreateFetchHistoryWindowInput {
  requestedSessionKey: string;
  getSessions: () => ChatSession[];
}

interface RunHistoryPipelineInput {
  set: ChatStoreSetFn;
  getState: () => ChatStoreState;
  scope: ChatHistoryLoadScope;
  requestedSessionKey: string;
  historyRuntime: StoreHistoryCache;
  abortSignal: AbortSignal;
  isAborted: () => boolean;
  fetchHistoryWindow: (limit: number) => Promise<HistoryWindowResult>;
  applyLoadedMessages: (rawMessages: RawMessage[], thinkingLevel: string | null) => Promise<void>;
}

interface ProbeShortCircuitInput {
  set: ChatStoreSetFn;
  getState: () => ChatStoreState;
  requestedSessionKey: string;
  historyRuntime: StoreHistoryCache;
  probeFingerprint: string;
}

function canShortCircuitByProbe(input: ProbeShortCircuitInput): boolean {
  const {
    set,
    getState,
    requestedSessionKey,
    historyRuntime,
    probeFingerprint,
  } = input;
  const previousProbeFingerprint = historyRuntime.historyProbeFingerprintBySession.get(requestedSessionKey) ?? null;
  historyRuntime.historyProbeFingerprintBySession.set(requestedSessionKey, probeFingerprint);

  const state = getState();
  const hasKnownFullSnapshot = historyRuntime.historyFingerprintBySession.has(requestedSessionKey);
  const hasRenderableMessages = state.currentSessionKey === requestedSessionKey
    ? state.messages.length > 0
    : (state.sessionRuntimeByKey[requestedSessionKey]?.messages.length ?? 0) > 0;
  const canShortCircuit = (
    previousProbeFingerprint === probeFingerprint
    && hasKnownFullSnapshot
    && hasRenderableMessages
  );
  if (!canShortCircuit) {
    return false;
  }
  if (!state.sessionReadyByKey[requestedSessionKey]) {
    set((current) => ({
      sessionReadyByKey: {
        ...current.sessionReadyByKey,
        [requestedSessionKey]: true,
      },
    }));
  }
  return true;
}

function shouldSkipByForegroundSessionMismatch(
  scope: ChatHistoryLoadScope,
  state: ChatStoreState,
  requestedSessionKey: string,
): boolean {
  return scope === 'foreground' && state.currentSessionKey !== requestedSessionKey;
}

async function measureHistoryStep<T>(
  event: string,
  payload: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = nowMs();
  try {
    return await task();
  } finally {
    trackUiTiming(event, Math.max(0, nowMs() - startedAt), payload);
  }
}

export async function loadCronFallbackMessages(
  sessionKey: string,
  limit = CHAT_HISTORY_FULL_LIMIT,
): Promise<RawMessage[]> {
  if (!isCronSessionKey(sessionKey)) return [];
  try {
    const payload = await hostApiFetch<unknown>(buildCronSessionHistoryPath(sessionKey, limit));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid cron session history payload: expected object');
    }
    const record = payload as Record<string, unknown>;
    if (!Array.isArray(record.messages)) {
      throw new Error('Invalid cron session history payload: expected messages[]');
    }
    return record.messages as RawMessage[];
  } catch {
    return [];
  }
}

export function createFetchHistoryWindow(
  input: CreateFetchHistoryWindowInput,
): (limit: number) => Promise<HistoryWindowResult> {
  const { requestedSessionKey, getSessions } = input;

  return async (limit: number): Promise<HistoryWindowResult> => {
    try {
      const sessionsGetData = await useGatewayStore.getState().rpc<Record<string, unknown>>(
        'sessions.get',
        { key: requestedSessionKey, limit },
      );
      if (Array.isArray(sessionsGetData?.messages)) {
        let rawMessages = sessionsGetData.messages as RawMessage[];
        const thinkingLevel = resolveSessionThinkingLevelFromList(getSessions(), requestedSessionKey);
        if (rawMessages.length === 0) {
          rawMessages = await loadCronFallbackMessages(requestedSessionKey, limit);
        }
        return { rawMessages, thinkingLevel };
      }
    } catch {
      // Ignore and fall back to chat.history for backward compatibility.
    }

    const data = await useGatewayStore.getState().rpc<Record<string, unknown>>(
      'chat.history',
      { sessionKey: requestedSessionKey, limit },
    );
    let rawMessages = Array.isArray(data?.messages) ? data.messages as RawMessage[] : [];
    const thinkingLevel = data?.thinkingLevel ? String(data.thinkingLevel) : null;
    if (rawMessages.length === 0) {
      rawMessages = await loadCronFallbackMessages(requestedSessionKey, limit);
    }
    return { rawMessages, thinkingLevel };
  };
}

export async function runQuietHistoryPipeline(input: RunHistoryPipelineInput): Promise<void> {
  const {
    set,
    getState,
    scope,
    requestedSessionKey,
    historyRuntime,
    abortSignal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
  } = input;

  throwIfHistoryLoadAborted(abortSignal, isAborted);
  const probe = await measureHistoryStep('chat.history_fetch_probe', {
    mode: 'quiet',
    sessionKey: requestedSessionKey,
    limit: CHAT_HISTORY_QUIET_PROBE_LIMIT,
  }, async () => fetchHistoryWindow(CHAT_HISTORY_QUIET_PROBE_LIMIT));
  throwIfHistoryLoadAborted(abortSignal, isAborted);
  if (shouldSkipByForegroundSessionMismatch(scope, getState(), requestedSessionKey)) {
    return;
  }
  const probeFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
  const probeQuickFingerprint = buildQuickRawHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
  if (canShortCircuitByProbe({
    set,
    getState,
    requestedSessionKey,
    historyRuntime,
    probeFingerprint,
  })) {
    return;
  }

  const shouldUseProbeAsFinal = probe.rawMessages.length < CHAT_HISTORY_QUIET_PROBE_LIMIT;
  if (shouldUseProbeAsFinal) {
    const fullFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
    historyRuntime.historyFingerprintBySession.set(requestedSessionKey, fullFingerprint);
    await measureHistoryStep('chat.history_apply_probe', {
      mode: 'quiet',
      sessionKey: requestedSessionKey,
      rows: probe.rawMessages.length,
      usedAsFinal: true,
    }, async () => applyLoadedMessages(probe.rawMessages, probe.thinkingLevel));
    return;
  }

  throwIfHistoryLoadAborted(abortSignal, isAborted);
  const full = await measureHistoryStep('chat.history_fetch_full', {
    mode: 'quiet',
    sessionKey: requestedSessionKey,
    limit: CHAT_HISTORY_QUIET_FULL_LIMIT,
  }, async () => fetchHistoryWindow(CHAT_HISTORY_QUIET_FULL_LIMIT));
  throwIfHistoryLoadAborted(abortSignal, isAborted);
  if (shouldSkipByForegroundSessionMismatch(scope, getState(), requestedSessionKey)) {
    return;
  }
  const fullFingerprint = buildHistoryFingerprint(full.rawMessages, full.thinkingLevel);
  const fullQuickFingerprint = buildQuickRawHistoryFingerprint(full.rawMessages, full.thinkingLevel);
  const shouldSkipRedundantFullApply = (
    fullFingerprint === probeFingerprint
    && fullQuickFingerprint === probeQuickFingerprint
  );
  historyRuntime.historyFingerprintBySession.set(requestedSessionKey, fullFingerprint);
  historyRuntime.historyProbeFingerprintBySession.set(requestedSessionKey, fullFingerprint);
  if (shouldSkipRedundantFullApply) {
    return;
  }
  await measureHistoryStep('chat.history_apply_full', {
    mode: 'quiet',
    sessionKey: requestedSessionKey,
    rows: full.rawMessages.length,
  }, async () => applyLoadedMessages(full.rawMessages, full.thinkingLevel));
}

export async function runActiveHistoryPipeline(input: RunHistoryPipelineInput): Promise<void> {
  const {
    scope,
    requestedSessionKey,
    historyRuntime,
    abortSignal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
    getState,
  } = input;

  throwIfHistoryLoadAborted(abortSignal, isAborted);
  const probe = await measureHistoryStep('chat.history_fetch_probe', {
    mode: 'active',
    sessionKey: requestedSessionKey,
    limit: CHAT_HISTORY_ACTIVE_PROBE_LIMIT,
  }, async () => fetchHistoryWindow(CHAT_HISTORY_ACTIVE_PROBE_LIMIT));
  throwIfHistoryLoadAborted(abortSignal, isAborted);
  if (shouldSkipByForegroundSessionMismatch(scope, getState(), requestedSessionKey)) {
    return;
  }
  const probeFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
  const probeQuickFingerprint = buildQuickRawHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
  if (canShortCircuitByProbe({
    set: input.set,
    getState,
    requestedSessionKey,
    historyRuntime,
    probeFingerprint,
  })) {
    return;
  }
  historyRuntime.historyFingerprintBySession.set(requestedSessionKey, probeFingerprint);
  historyRuntime.historyProbeFingerprintBySession.set(requestedSessionKey, probeFingerprint);
  await measureHistoryStep('chat.history_apply_probe', {
    mode: 'active',
    sessionKey: requestedSessionKey,
    rows: probe.rawMessages.length,
    usedAsFinal: probe.rawMessages.length < CHAT_HISTORY_ACTIVE_PROBE_LIMIT,
  }, async () => applyLoadedMessages(probe.rawMessages, probe.thinkingLevel));

  if (probe.rawMessages.length < CHAT_HISTORY_ACTIVE_PROBE_LIMIT) {
    return;
  }

  try {
    throwIfHistoryLoadAborted(abortSignal, isAborted);
    const full = await measureHistoryStep('chat.history_fetch_full', {
      mode: 'active',
      sessionKey: requestedSessionKey,
      limit: CHAT_HISTORY_FULL_LIMIT,
    }, async () => fetchHistoryWindow(CHAT_HISTORY_FULL_LIMIT));
    throwIfHistoryLoadAborted(abortSignal, isAborted);
    if (shouldSkipByForegroundSessionMismatch(scope, getState(), requestedSessionKey)) {
      return;
    }
    const fullFingerprint = buildHistoryFingerprint(full.rawMessages, full.thinkingLevel);
    const fullQuickFingerprint = buildQuickRawHistoryFingerprint(full.rawMessages, full.thinkingLevel);
    const shouldSkipRedundantFullApply = (
      fullFingerprint === probeFingerprint
      && fullQuickFingerprint === probeQuickFingerprint
    );
    historyRuntime.historyFingerprintBySession.set(requestedSessionKey, fullFingerprint);
    historyRuntime.historyProbeFingerprintBySession.set(requestedSessionKey, fullFingerprint);
    if (shouldSkipRedundantFullApply) {
      return;
    }
    await measureHistoryStep('chat.history_apply_full', {
      mode: 'active',
      sessionKey: requestedSessionKey,
      rows: full.rawMessages.length,
    }, async () => applyLoadedMessages(full.rawMessages, full.thinkingLevel));
  } catch (fullErr) {
    if (isHistoryLoadAbortError(fullErr)) {
      throw fullErr;
    }
  }
}
