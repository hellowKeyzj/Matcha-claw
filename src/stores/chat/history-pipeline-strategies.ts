import {
  CHAT_HISTORY_ACTIVE_PROBE_LIMIT,
  CHAT_HISTORY_QUIET_PROBE_LIMIT,
  runActiveHistoryPipeline,
  runQuietHistoryPipeline,
} from './history-fetch-helpers';
import { buildHistoryFingerprint } from './store-state-helpers';
import { throwIfHistoryLoadAborted } from './history-abort';
import type { HistoryLoadPipelineContext, HistoryLoadPipelineStrategy } from './history-pipeline-types';

export const HISTORY_LOAD_PIPELINE_STRATEGY_STORAGE_KEY = 'matcha.chat.history.pipelineStrategy';

export const HISTORY_LOAD_PIPELINE_STRATEGY_KEYS = [
  'default',
  'active_only',
  'quiet_only',
  'probe_only',
] as const;

export type HistoryLoadPipelineStrategyKey = (typeof HISTORY_LOAD_PIPELINE_STRATEGY_KEYS)[number];

type HistoryLoadPipelineStrategyRegistry = Record<HistoryLoadPipelineStrategyKey, HistoryLoadPipelineStrategy>;

async function runProbeOnlyHistoryPipeline(context: HistoryLoadPipelineContext): Promise<void> {
  const {
    get,
    scope,
    mode,
    requestedSessionKey,
    historyRuntime,
    fetchHistoryWindow,
    applyLoadedMessages,
    abortSignal,
    isAborted,
  } = context;

  throwIfHistoryLoadAborted(abortSignal, isAborted);
  const probeLimit = mode === 'quiet' ? CHAT_HISTORY_QUIET_PROBE_LIMIT : CHAT_HISTORY_ACTIVE_PROBE_LIMIT;
  const probe = await fetchHistoryWindow(probeLimit);
  throwIfHistoryLoadAborted(abortSignal, isAborted);
  if (scope === 'foreground' && get().currentSessionKey !== requestedSessionKey) {
    return;
  }

  const probeFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
  historyRuntime.historyFingerprintBySession.set(requestedSessionKey, probeFingerprint);
  historyRuntime.historyProbeFingerprintBySession.set(requestedSessionKey, probeFingerprint);
  await applyLoadedMessages(probe.rawMessages, probe.thinkingLevel);
}

export const defaultHistoryLoadPipelineStrategy: HistoryLoadPipelineStrategy = async (context) => {
  const {
    set,
    get,
    requestedSessionKey,
    historyRuntime,
    fetchHistoryWindow,
    applyLoadedMessages,
    mode,
    scope,
    abortSignal,
    isAborted,
  } = context;

  if (mode === 'quiet') {
    await runQuietHistoryPipeline({
      set,
      getState: get,
      scope,
      requestedSessionKey,
      historyRuntime,
      abortSignal,
      isAborted,
      fetchHistoryWindow,
      applyLoadedMessages,
    });
    return;
  }

  await runActiveHistoryPipeline({
    set,
    getState: get,
    scope,
    requestedSessionKey,
    historyRuntime,
    abortSignal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
  });
};

const activeOnlyHistoryLoadPipelineStrategy: HistoryLoadPipelineStrategy = async (context) => {
  const {
    set,
    get,
    requestedSessionKey,
    historyRuntime,
    abortSignal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
  } = context;

  await runActiveHistoryPipeline({
    set,
    getState: get,
    scope: context.scope,
    requestedSessionKey,
    historyRuntime,
    abortSignal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
  });
};

const quietOnlyHistoryLoadPipelineStrategy: HistoryLoadPipelineStrategy = async (context) => {
  const {
    set,
    get,
    requestedSessionKey,
    historyRuntime,
    abortSignal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
  } = context;

  await runQuietHistoryPipeline({
    set,
    getState: get,
    scope: context.scope,
    requestedSessionKey,
    historyRuntime,
    abortSignal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
  });
};

export const historyLoadPipelineStrategyRegistry: HistoryLoadPipelineStrategyRegistry = {
  default: defaultHistoryLoadPipelineStrategy,
  active_only: activeOnlyHistoryLoadPipelineStrategy,
  quiet_only: quietOnlyHistoryLoadPipelineStrategy,
  probe_only: runProbeOnlyHistoryPipeline,
};

function normalizeStrategyKey(rawKey: string | null | undefined): string {
  return typeof rawKey === 'string' ? rawKey.trim().toLowerCase() : '';
}

export function resolveHistoryLoadPipelineStrategyKey(
  rawKey: string | null | undefined,
): HistoryLoadPipelineStrategyKey {
  const normalized = normalizeStrategyKey(rawKey);
  if (normalized in historyLoadPipelineStrategyRegistry) {
    return normalized as HistoryLoadPipelineStrategyKey;
  }
  if (normalized === 'active') {
    return 'active_only';
  }
  if (normalized === 'quiet') {
    return 'quiet_only';
  }
  if (normalized === 'probe') {
    return 'probe_only';
  }
  return 'default';
}

export function resolveHistoryLoadPipelineStrategy(
  rawKey: string | null | undefined,
): HistoryLoadPipelineStrategy {
  return historyLoadPipelineStrategyRegistry[resolveHistoryLoadPipelineStrategyKey(rawKey)];
}

interface ReadHistoryLoadPipelineStrategyKeyInput {
  storage?: Pick<Storage, 'getItem'> | null;
  storageKey?: string;
}

export function readHistoryLoadPipelineStrategyKey(
  input: ReadHistoryLoadPipelineStrategyKeyInput = {},
): string | null {
  const {
    storage = typeof window !== 'undefined' ? window.localStorage : null,
    storageKey = HISTORY_LOAD_PIPELINE_STRATEGY_STORAGE_KEY,
  } = input;

  if (!storage || typeof storage.getItem !== 'function') {
    return null;
  }

  try {
    const raw = storage.getItem(storageKey);
    if (typeof raw !== 'string') {
      return null;
    }
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}
