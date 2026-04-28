import { describe, expect, it, vi } from 'vitest';
import { buildHistoryFingerprint, createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import {
  CHAT_HISTORY_FULL_LIMIT,
  createFetchHistoryWindow,
  loadHistoryWindow,
} from '@/stores/chat/history-fetch-helpers';
import { useGatewayStore } from '@/stores/gateway';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';

const hostSessionWindowFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
  hostSessionWindowFetch: (...args: unknown[]) => hostSessionWindowFetchMock(...args),
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
    sessionsByKey: {
      'agent:main:main': createEmptySessionRecord(),
    },
    ...overrides,
  } as ChatStoreState;

  return {
    getState: () => state,
  };
}

describe('chat history fetch pipeline helpers', () => {
  it('falls back to gateway history when host window responds empty for a non-empty historical session', async () => {
    const requestedSessionKey = 'agent:test:session-1';
    hostSessionWindowFetchMock.mockReset();
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: [],
      canonicalMessages: [],
      totalMessageCount: 0,
      windowStartOffset: 0,
      windowEndOffset: 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    });
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'sessions.get') {
        return {
          messages: [
            { role: 'user', content: '历史正文还在', timestamp: 1 },
          ],
        };
      }
      return {};
    });
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    const fetchHistoryWindow = createFetchHistoryWindow({
      requestedSessionKey,
      getSessions: () => [{ key: requestedSessionKey, updatedAt: 1 }],
    });
    const result = await fetchHistoryWindow(CHAT_HISTORY_FULL_LIMIT);

    expect(hostSessionWindowFetchMock).toHaveBeenCalledWith({
      sessionKey: requestedSessionKey,
      mode: 'latest',
      limit: CHAT_HISTORY_FULL_LIMIT,
      includeCanonical: true,
    });
    expect(rpcMock).toHaveBeenCalledWith('sessions.get', {
      key: requestedSessionKey,
      limit: CHAT_HISTORY_FULL_LIMIT,
    });
    expect(rpcMock).not.toHaveBeenCalledWith('chat.history', expect.anything());
    expect(result.rawMessages).toEqual([
      { role: 'user', content: '历史正文还在', timestamp: 1 },
    ]);
    expect(result.totalMessageCount).toBe(1);
    expect(result.isAtLatest).toBe(true);
  });

  it('fetches one latest window and applies it directly', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const { getState } = createStateHarness({ currentSessionKey: requestedSessionKey });
    const rawMessages: RawMessage[] = [
      { role: 'assistant', content: 'a', timestamp: 1 },
      { role: 'assistant', content: 'b', timestamp: 2 },
    ];
    const fetchHistoryWindow = vi.fn(async () => ({
      rawMessages,
      thinkingLevel: 'medium' as const,
      totalMessageCount: rawMessages.length,
      windowStartOffset: 0,
      windowEndOffset: rawMessages.length,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }));
    const applyLoadedMessages = vi.fn(async () => {});

    await loadHistoryWindow({
      getState,
      mode: 'active',
      scope: 'foreground',
      requestedSessionKey,
      historyRuntime,
      abortSignal: new AbortController().signal,
      isAborted: () => false,
      fetchHistoryWindow,
      applyLoadedMessages,
    });

    expect(fetchHistoryWindow).toHaveBeenCalledTimes(1);
    expect(fetchHistoryWindow).toHaveBeenCalledWith(CHAT_HISTORY_FULL_LIMIT);
    expect(applyLoadedMessages).toHaveBeenCalledTimes(1);
    expect(applyLoadedMessages).toHaveBeenCalledWith(expect.objectContaining({
      rawMessages,
      thinkingLevel: 'medium',
      totalMessageCount: rawMessages.length,
      windowStartOffset: 0,
      windowEndOffset: rawMessages.length,
    }));
    expect(historyRuntime.historyFingerprintBySession.get(requestedSessionKey)).toBe(
      buildHistoryFingerprint(rawMessages, 'medium'),
    );
  });

  it('skips apply when foreground session changed before window is applied', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const { getState } = createStateHarness({ currentSessionKey: 'agent:main:other' });
    const fetchHistoryWindow = vi.fn(async () => ({
      rawMessages: [{ role: 'assistant', content: 'stale', timestamp: 1 }] as RawMessage[],
      thinkingLevel: null,
      totalMessageCount: 1,
      windowStartOffset: 0,
      windowEndOffset: 1,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }));
    const applyLoadedMessages = vi.fn(async () => {});

    await loadHistoryWindow({
      getState,
      mode: 'quiet',
      scope: 'foreground',
      requestedSessionKey,
      historyRuntime,
      abortSignal: new AbortController().signal,
      isAborted: () => false,
      fetchHistoryWindow,
      applyLoadedMessages,
    });

    expect(fetchHistoryWindow).toHaveBeenCalledTimes(1);
    expect(applyLoadedMessages).not.toHaveBeenCalled();
    expect(historyRuntime.historyFingerprintBySession.has(requestedSessionKey)).toBe(false);
  });

  it('stops when abort is raised after window fetch', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const { getState } = createStateHarness({ currentSessionKey: requestedSessionKey });
    let aborted = false;
    const fetchHistoryWindow = vi.fn(async () => {
      aborted = true;
      return {
        rawMessages: [{ role: 'assistant', content: 'late', timestamp: 1 }] as RawMessage[],
        thinkingLevel: null,
        totalMessageCount: 1,
        windowStartOffset: 0,
        windowEndOffset: 1,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      };
    });
    const applyLoadedMessages = vi.fn(async () => {});

    await expect(loadHistoryWindow({
      getState,
      mode: 'quiet',
      scope: 'foreground',
      requestedSessionKey,
      historyRuntime,
      abortSignal: new AbortController().signal,
      isAborted: () => aborted,
      fetchHistoryWindow,
      applyLoadedMessages,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchHistoryWindow).toHaveBeenCalledTimes(1);
    expect(applyLoadedMessages).not.toHaveBeenCalled();
  });
});
