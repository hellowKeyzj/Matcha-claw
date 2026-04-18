import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { HistoryLoadPipelineStrategy } from '@/stores/chat/history-load-execution';
import type { ChatStoreState } from '@/stores/chat/types';

const createHistoryLoadExecutorMock = vi.fn();
const resolveHistoryLoadPipelineStrategyMock = vi.fn();
const resolveHistoryLoadPipelineStrategyKeyMock = vi.fn();
const readHistoryLoadPipelineStrategyKeyMock = vi.fn();

vi.mock('@/stores/chat/history-load-execution', () => ({
  createHistoryLoadExecutor: (...args: unknown[]) => createHistoryLoadExecutorMock(...args),
}));

vi.mock('@/stores/chat/history-pipeline-strategies', () => ({
  resolveHistoryLoadPipelineStrategy: (...args: unknown[]) => resolveHistoryLoadPipelineStrategyMock(...args),
  resolveHistoryLoadPipelineStrategyKey: (...args: unknown[]) => resolveHistoryLoadPipelineStrategyKeyMock(...args),
  readHistoryLoadPipelineStrategyKey: (...args: unknown[]) => readHistoryLoadPipelineStrategyKeyMock(...args),
}));

function createHistoryRuntimeHarness(): StoreHistoryCache {
  let runId = 0;
  return {
    getHistoryLoadRunId: () => runId,
    nextHistoryLoadRunId: () => {
      runId += 1;
      return runId;
    },
    replaceHistoryLoadAbortController: () => null,
    clearHistoryLoadAbortController: () => {},
    historyFingerprintBySession: new Map<string, string>(),
    historyProbeFingerprintBySession: new Map<string, string>(),
    historyQuickFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createStateHarness() {
  let state = {
    currentSessionKey: 'agent:main:main',
    sessions: [],
  } as ChatStoreState;

  const set = (
    partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  ) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };

  return {
    set,
    get: () => state,
  };
}

describe('chat history store actions', () => {
  beforeEach(() => {
    createHistoryLoadExecutorMock.mockReset();
    resolveHistoryLoadPipelineStrategyMock.mockReset();
    resolveHistoryLoadPipelineStrategyKeyMock.mockReset();
    readHistoryLoadPipelineStrategyKeyMock.mockReset();

    const executeMock = vi.fn(async () => {});
    createHistoryLoadExecutorMock.mockReturnValue({
      execute: executeMock,
    });
    resolveHistoryLoadPipelineStrategyMock.mockReturnValue(executeMock as unknown as HistoryLoadPipelineStrategy);
    resolveHistoryLoadPipelineStrategyKeyMock.mockReturnValue('default');
    readHistoryLoadPipelineStrategyKeyMock.mockReturnValue(null);
  });

  it('resolves strategy via resolver when no explicit strategy is provided', async () => {
    const { createStoreHistoryActions } = await import('@/stores/chat/history-store-actions');
    const { set, get } = createStateHarness();
    const historyRuntime = createHistoryRuntimeHarness();

    const actions = createStoreHistoryActions({
      set,
      get,
      historyRuntime,
      readPipelineStrategyKey: () => null,
    });

    await actions.loadHistory({
      sessionKey: 'agent:main:main',
      mode: 'quiet',
      scope: 'foreground',
    });

    expect(resolveHistoryLoadPipelineStrategyMock).toHaveBeenCalledTimes(1);
    expect(createHistoryLoadExecutorMock).toHaveBeenCalledTimes(1);
  });

  it('uses provided strategy function and skips strategy key resolution', async () => {
    const { createStoreHistoryActions } = await import('@/stores/chat/history-store-actions');
    const { set, get } = createStateHarness();
    const historyRuntime = createHistoryRuntimeHarness();
    const explicitStrategy = vi.fn(async () => {});

    const actions = createStoreHistoryActions({
      set,
      get,
      historyRuntime,
      pipelineStrategy: explicitStrategy,
    });
    await actions.loadHistory({
      sessionKey: 'agent:main:main',
      mode: 'active',
      scope: 'foreground',
    });

    expect(resolveHistoryLoadPipelineStrategyMock).not.toHaveBeenCalled();
    expect(readHistoryLoadPipelineStrategyKeyMock).not.toHaveBeenCalled();
    expect(createHistoryLoadExecutorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineStrategy: explicitStrategy,
        pipelineStrategyLabel: 'custom',
      }),
    );
  });

  it('prefers pipelineStrategyKey over storage lookup', async () => {
    const { createStoreHistoryActions } = await import('@/stores/chat/history-store-actions');
    const { set, get } = createStateHarness();
    const historyRuntime = createHistoryRuntimeHarness();

    resolveHistoryLoadPipelineStrategyKeyMock.mockReturnValueOnce('probe_only');
    const actions = createStoreHistoryActions({
      set,
      get,
      historyRuntime,
      pipelineStrategyKey: 'probe_only',
    });
    await actions.loadHistory({
      sessionKey: 'agent:main:main',
      mode: 'active',
      scope: 'foreground',
    });

    expect(resolveHistoryLoadPipelineStrategyMock).toHaveBeenCalledWith('probe_only');
    expect(readHistoryLoadPipelineStrategyKeyMock).not.toHaveBeenCalled();
    expect(createHistoryLoadExecutorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineStrategyLabel: 'probe_only',
      }),
    );
  });

  it('uses dynamic key reader before storage fallback', async () => {
    const { createStoreHistoryActions } = await import('@/stores/chat/history-store-actions');
    const { set, get } = createStateHarness();
    const historyRuntime = createHistoryRuntimeHarness();

    resolveHistoryLoadPipelineStrategyKeyMock.mockReturnValueOnce('active_only');
    const actions = createStoreHistoryActions({
      set,
      get,
      historyRuntime,
      readPipelineStrategyKey: () => 'active_only',
    });
    await actions.loadHistory({
      sessionKey: 'agent:main:main',
      mode: 'active',
      scope: 'foreground',
    });

    expect(resolveHistoryLoadPipelineStrategyMock).toHaveBeenCalledWith('active_only');
    expect(readHistoryLoadPipelineStrategyKeyMock).not.toHaveBeenCalled();
    expect(createHistoryLoadExecutorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineStrategyLabel: 'active_only',
      }),
    );
  });
});
