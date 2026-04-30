import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState } from '@/stores/chat/types';

const createHistoryLoadExecutorMock = vi.fn();

vi.mock('@/stores/chat/history-load-execution', () => ({
  createHistoryLoadExecutor: (...args: unknown[]) => createHistoryLoadExecutorMock(...args),
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

function createStateHarness() {
  let state = {
    currentSessionKey: 'agent:main:main',
    sessionMetasResource: {
      status: 'ready' as const,
      data: [],
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: 1,
    },
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
    createHistoryLoadExecutorMock.mockReturnValue({
      execute: vi.fn(async () => {}),
    });
  });

  it('normalizes session key and invokes the single history executor', async () => {
    const { createStoreHistoryActions } = await import('@/stores/chat/history-store-actions');
    const { set, get } = createStateHarness();
    const historyRuntime = createHistoryRuntimeHarness();

    const actions = createStoreHistoryActions({
      set,
      get,
      historyRuntime,
    });

    await actions.loadHistory({
      sessionKey: '  agent:main:main  ',
      mode: 'quiet',
      scope: 'foreground',
    });

    expect(createHistoryLoadExecutorMock).toHaveBeenCalledTimes(1);
    expect(createHistoryLoadExecutorMock.mock.results[0]?.value.execute).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      mode: 'quiet',
      scope: 'foreground',
    });
  });

  it('skips execution when session key is blank', async () => {
    const { createStoreHistoryActions } = await import('@/stores/chat/history-store-actions');
    const { set, get } = createStateHarness();
    const historyRuntime = createHistoryRuntimeHarness();

    const actions = createStoreHistoryActions({
      set,
      get,
      historyRuntime,
    });

    await actions.loadHistory({
      sessionKey: '   ',
      mode: 'active',
      scope: 'foreground',
    });

    expect(createHistoryLoadExecutorMock).not.toHaveBeenCalled();
  });
});

