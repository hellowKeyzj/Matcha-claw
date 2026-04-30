import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState } from '@/stores/chat/types';

const createFetchHistoryWindowMock = vi.fn();
const loadHistoryWindowMock = vi.fn();
const createApplyLoadedMessagesPipelineMock = vi.fn();
const handleHistoryLoadFailureMock = vi.fn();
const beginHistoryLoadUiStateMock = vi.fn();
const createHistoryLoadAbortGuardMock = vi.fn();
const finalizeHistoryLoadUiStateMock = vi.fn();

vi.mock('@/stores/chat/history-fetch-helpers', () => ({
  createFetchHistoryWindow: (...args: unknown[]) => createFetchHistoryWindowMock(...args),
  loadHistoryWindow: (...args: unknown[]) => loadHistoryWindowMock(...args),
}));

vi.mock('@/stores/chat/history-apply-pipeline', () => ({
  createApplyLoadedMessagesPipeline: (...args: unknown[]) => createApplyLoadedMessagesPipelineMock(...args),
}));

vi.mock('@/stores/chat/history-failure-helpers', () => ({
  handleHistoryLoadFailure: (...args: unknown[]) => handleHistoryLoadFailureMock(...args),
}));

vi.mock('@/stores/chat/history-loading-helpers', () => ({
  beginHistoryLoadUiState: (...args: unknown[]) => beginHistoryLoadUiStateMock(...args),
  createHistoryLoadAbortGuard: (...args: unknown[]) => createHistoryLoadAbortGuardMock(...args),
  finalizeHistoryLoadUiState: (...args: unknown[]) => finalizeHistoryLoadUiStateMock(...args),
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
    historyQuickFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createStateHarness(overrides: Partial<ChatStoreState>) {
  let state = {
    currentSessionKey: 'agent:main:main',
    sessionCatalogStatus: {
      status: 'ready' as const,
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: 1,
    },
  } as ChatStoreState;
  state = { ...state, ...overrides } as ChatStoreState;

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

describe('chat history load execution', () => {
  beforeEach(() => {
    createFetchHistoryWindowMock.mockReset();
    loadHistoryWindowMock.mockReset();
    createApplyLoadedMessagesPipelineMock.mockReset();
    handleHistoryLoadFailureMock.mockReset();
    beginHistoryLoadUiStateMock.mockReset();
    createHistoryLoadAbortGuardMock.mockReset();
    finalizeHistoryLoadUiStateMock.mockReset();

    createFetchHistoryWindowMock.mockReturnValue(vi.fn(async () => ({ rawMessages: [], thinkingLevel: null })));
    createApplyLoadedMessagesPipelineMock.mockReturnValue(vi.fn(async () => {}));
    createHistoryLoadAbortGuardMock.mockReturnValue(() => false);
    beginHistoryLoadUiStateMock.mockReturnValue(null);
    loadHistoryWindowMock.mockResolvedValue(undefined);
    handleHistoryLoadFailureMock.mockResolvedValue(undefined);
  });

  it('runs window loader for active requests and finalizes loading state', async () => {
    const { createHistoryLoadExecutor } = await import('@/stores/chat/history-load-execution');
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const historyRuntime = createHistoryRuntimeHarness();

    const executor = createHistoryLoadExecutor({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
    });

    await executor.execute({
      sessionKey: 'agent:main:main',
      mode: 'active',
      scope: 'foreground',
    });

    expect(loadHistoryWindowMock).toHaveBeenCalledTimes(1);
    expect(loadHistoryWindowMock.mock.calls[0]?.[0]).toMatchObject({
      mode: 'active',
      scope: 'foreground',
      requestedSessionKey: 'agent:main:main',
    });
    expect(finalizeHistoryLoadUiStateMock).toHaveBeenCalledTimes(1);
  });

  it('passes quiet mode through the same window loader', async () => {
    const { createHistoryLoadExecutor } = await import('@/stores/chat/history-load-execution');
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const historyRuntime = createHistoryRuntimeHarness();

    const executor = createHistoryLoadExecutor({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
    });

    await executor.execute({
      sessionKey: 'agent:main:main',
      mode: 'quiet',
      scope: 'foreground',
    });

    expect(loadHistoryWindowMock).toHaveBeenCalledTimes(1);
    expect(loadHistoryWindowMock.mock.calls[0]?.[0]).toMatchObject({
      mode: 'quiet',
      scope: 'foreground',
      requestedSessionKey: 'agent:main:main',
    });
    expect(finalizeHistoryLoadUiStateMock).toHaveBeenCalledTimes(1);
  });

  it('recovers through failure helper when window loader throws', async () => {
    const { createHistoryLoadExecutor } = await import('@/stores/chat/history-load-execution');
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const historyRuntime = createHistoryRuntimeHarness();
    loadHistoryWindowMock.mockRejectedValueOnce(new Error('window failed'));

    const executor = createHistoryLoadExecutor({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
    });

    await executor.execute({
      sessionKey: 'agent:main:main',
      mode: 'active',
      scope: 'foreground',
    });

    expect(handleHistoryLoadFailureMock).toHaveBeenCalledTimes(1);
    expect(finalizeHistoryLoadUiStateMock).toHaveBeenCalledTimes(1);
  });

  it('treats abort error as aborted outcome without failure recovery', async () => {
    const { createHistoryLoadExecutor } = await import('@/stores/chat/history-load-execution');
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const historyRuntime = createHistoryRuntimeHarness();
    loadHistoryWindowMock.mockImplementationOnce(async () => {
      const error = new Error('history aborted');
      error.name = 'AbortError';
      throw error;
    });

    const executor = createHistoryLoadExecutor({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
    });

    await executor.execute({
      sessionKey: 'agent:main:main',
      mode: 'active',
      scope: 'foreground',
    });

    expect(handleHistoryLoadFailureMock).not.toHaveBeenCalled();
    expect(finalizeHistoryLoadUiStateMock).toHaveBeenCalledTimes(1);
  });
});

