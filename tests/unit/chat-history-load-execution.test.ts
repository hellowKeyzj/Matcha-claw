import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState } from '@/stores/chat/types';

const createFetchHistoryWindowMock = vi.fn();
const runActiveHistoryPipelineMock = vi.fn();
const runQuietHistoryPipelineMock = vi.fn();
const createApplyLoadedMessagesPipelineMock = vi.fn();
const handleHistoryLoadFailureMock = vi.fn();
const beginHistoryLoadUiStateMock = vi.fn();
const createHistoryLoadAbortGuardMock = vi.fn();
const finalizeHistoryLoadUiStateMock = vi.fn();

vi.mock('@/stores/chat/history-fetch-helpers', () => ({
  createFetchHistoryWindow: (...args: unknown[]) => createFetchHistoryWindowMock(...args),
  runActiveHistoryPipeline: (...args: unknown[]) => runActiveHistoryPipelineMock(...args),
  runQuietHistoryPipeline: (...args: unknown[]) => runQuietHistoryPipelineMock(...args),
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
    historyProbeFingerprintBySession: new Map<string, string>(),
    historyQuickFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createStateHarness(overrides: Partial<ChatStoreState>) {
  let state = {
    currentSessionKey: 'agent:main:main',
    sessions: [],
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
    runActiveHistoryPipelineMock.mockReset();
    runQuietHistoryPipelineMock.mockReset();
    createApplyLoadedMessagesPipelineMock.mockReset();
    handleHistoryLoadFailureMock.mockReset();
    beginHistoryLoadUiStateMock.mockReset();
    createHistoryLoadAbortGuardMock.mockReset();
    finalizeHistoryLoadUiStateMock.mockReset();

    createFetchHistoryWindowMock.mockReturnValue(vi.fn(async () => ({ rawMessages: [], thinkingLevel: null })));
    createApplyLoadedMessagesPipelineMock.mockReturnValue(vi.fn(async () => {}));
    createHistoryLoadAbortGuardMock.mockReturnValue(() => false);
    beginHistoryLoadUiStateMock.mockReturnValue(null);
    runActiveHistoryPipelineMock.mockResolvedValue(undefined);
    runQuietHistoryPipelineMock.mockResolvedValue(undefined);
    handleHistoryLoadFailureMock.mockResolvedValue(undefined);
  });

  it('runs active pipeline and finalizes loading state', async () => {
    const { createHistoryLoadExecutor } = await import('@/stores/chat/history-load-execution');
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const historyRuntime = createHistoryRuntimeHarness();

    const executor = createHistoryLoadExecutor({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
      optimisticUserReconcileWindowMs: 15_000,
    });

    await executor.execute(false);

    expect(runActiveHistoryPipelineMock).toHaveBeenCalledTimes(1);
    expect(runQuietHistoryPipelineMock).not.toHaveBeenCalled();
    expect(finalizeHistoryLoadUiStateMock).toHaveBeenCalledTimes(1);
  });

  it('runs quiet pipeline when requested', async () => {
    const { createHistoryLoadExecutor } = await import('@/stores/chat/history-load-execution');
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const historyRuntime = createHistoryRuntimeHarness();

    const executor = createHistoryLoadExecutor({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
      optimisticUserReconcileWindowMs: 15_000,
    });

    await executor.execute(true);

    expect(runQuietHistoryPipelineMock).toHaveBeenCalledTimes(1);
    expect(runActiveHistoryPipelineMock).not.toHaveBeenCalled();
    expect(finalizeHistoryLoadUiStateMock).toHaveBeenCalledTimes(1);
  });

  it('recovers through failure helper when pipeline throws', async () => {
    const { createHistoryLoadExecutor } = await import('@/stores/chat/history-load-execution');
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const historyRuntime = createHistoryRuntimeHarness();
    runActiveHistoryPipelineMock.mockRejectedValueOnce(new Error('pipeline failed'));

    const executor = createHistoryLoadExecutor({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
      optimisticUserReconcileWindowMs: 15_000,
    });

    await executor.execute(false);

    expect(handleHistoryLoadFailureMock).toHaveBeenCalledTimes(1);
    expect(finalizeHistoryLoadUiStateMock).toHaveBeenCalledTimes(1);
  });

  it('uses injected pipeline strategy instead of default active/quiet runners', async () => {
    const { createHistoryLoadExecutor } = await import('@/stores/chat/history-load-execution');
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const historyRuntime = createHistoryRuntimeHarness();
    const strategySpy = vi.fn(async () => {});

    const executor = createHistoryLoadExecutor({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
      optimisticUserReconcileWindowMs: 15_000,
      pipelineStrategy: strategySpy,
    });

    await executor.execute(false);

    expect(strategySpy).toHaveBeenCalledTimes(1);
    expect(runActiveHistoryPipelineMock).not.toHaveBeenCalled();
    expect(runQuietHistoryPipelineMock).not.toHaveBeenCalled();
    expect(finalizeHistoryLoadUiStateMock).toHaveBeenCalledTimes(1);
  });

  it('treats abort error as aborted outcome without failure recovery', async () => {
    const { createHistoryLoadExecutor } = await import('@/stores/chat/history-load-execution');
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const historyRuntime = createHistoryRuntimeHarness();
    const strategySpy = vi.fn(async () => {
      const error = new Error('history aborted');
      error.name = 'AbortError';
      throw error;
    });

    const executor = createHistoryLoadExecutor({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
      optimisticUserReconcileWindowMs: 15_000,
      pipelineStrategy: strategySpy,
    });

    await executor.execute(false);

    expect(handleHistoryLoadFailureMock).not.toHaveBeenCalled();
    expect(finalizeHistoryLoadUiStateMock).toHaveBeenCalledTimes(1);
  });
});

