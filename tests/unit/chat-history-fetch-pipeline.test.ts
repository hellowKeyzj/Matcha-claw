import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_HISTORY_FULL_LIMIT,
  fetchHistoryWindow,
} from '@/stores/chat/history-fetch-helpers';
import {
  buildRenderItemsFromMessages,
  type RawMessage,
} from './helpers/timeline-fixtures';

const hostSessionLoadMock = vi.fn();
const hostSessionWindowFetchMock = vi.fn();
const waitForRuntimeJobResultMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
  hostSessionLoad: (...args: unknown[]) => hostSessionLoadMock(...args),
  hostSessionWindowFetch: (...args: unknown[]) => hostSessionWindowFetchMock(...args),
  waitForRuntimeJobResult: (...args: unknown[]) => waitForRuntimeJobResultMock(...args),
}));

describe('chat history fetch pipeline helpers', () => {
  it('returns host session load result directly when adapter already provides render items', async () => {
    const requestedSessionKey = 'agent:main:main';
    const sourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'a', timestamp: 1 },
      { role: 'assistant', content: 'b', timestamp: 2 },
    ];
    hostSessionLoadMock.mockReset();
    hostSessionWindowFetchMock.mockReset();
    waitForRuntimeJobResultMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce({
      snapshot: {
        sessionKey: requestedSessionKey,
        items: buildRenderItemsFromMessages(requestedSessionKey, sourceMessages),
        approvals: [],
        replayComplete: true,
        runtime: {
          activeRunId: null,
          runPhase: 'idle',
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          runtimeActivity: null,
          lastUserMessageAt: null,
          lastError: null,
          lastIssue: null,
          updatedAt: null,
        },
        window: {
          totalItemCount: sourceMessages.length,
          windowStartOffset: 0,
          windowEndOffset: sourceMessages.length,
          hasMore: false,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    });

    const result = await fetchHistoryWindow({
      requestedSessionKey,
      sessions: [{ key: requestedSessionKey, thinkingLevel: 'medium', updatedAt: 1 }],
      limit: CHAT_HISTORY_FULL_LIMIT,
    });

    expect(result).toEqual(expect.objectContaining({
      thinkingLevel: 'medium',
      totalItemCount: sourceMessages.length,
      windowStartOffset: 0,
      windowEndOffset: sourceMessages.length,
    }));
    expect(result.snapshot?.items).toMatchObject([
      {
        role: 'assistant',
        text: 'a',
        laneKey: 'main',
        turnKey: expect.any(String),
      },
      {
        role: 'assistant',
        text: 'b',
        laneKey: 'main',
        turnKey: expect.any(String),
      },
    ]);
  });

  it('fetches latest window after hydration job completes without reading job result', async () => {
    const requestedSessionKey = 'agent:main:main';
    const sourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'hydrated', timestamp: 1 },
    ];
    hostSessionLoadMock.mockReset();
    hostSessionWindowFetchMock.mockReset();
    waitForRuntimeJobResultMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce({
      hydrationJob: {
        id: 'hydrate-1',
        type: 'sessions.hydrateTimeline',
        status: 'queued',
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    });
    waitForRuntimeJobResultMock.mockResolvedValueOnce(undefined);
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      snapshot: {
        sessionKey: requestedSessionKey,
        items: buildRenderItemsFromMessages(requestedSessionKey, sourceMessages),
        approvals: [],
        replayComplete: true,
        runtime: {
          activeRunId: null,
          runPhase: 'idle',
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          runtimeActivity: null,
          lastUserMessageAt: null,
          lastError: null,
          lastIssue: null,
          updatedAt: null,
        },
        window: {
          totalItemCount: sourceMessages.length,
          windowStartOffset: 0,
          windowEndOffset: sourceMessages.length,
          hasMore: false,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    });

    const result = await fetchHistoryWindow({
      requestedSessionKey,
      sessions: [{ key: requestedSessionKey, updatedAt: 1 }],
      limit: CHAT_HISTORY_FULL_LIMIT,
    });

    expect(waitForRuntimeJobResultMock).toHaveBeenCalledWith('hydrate-1', {
      timeoutMs: undefined,
    });
    expect(hostSessionWindowFetchMock).toHaveBeenCalledWith({
      sessionKey: requestedSessionKey,
      mode: 'latest',
      limit: CHAT_HISTORY_FULL_LIMIT,
    });
    expect(result.snapshot?.items).toMatchObject([{ text: 'hydrated' }]);
  });

  it('does not fall back to gateway history for normal sessions when adapter returns empty replay', async () => {
    const requestedSessionKey = 'agent:test:session-1';
    hostSessionLoadMock.mockReset();
    hostSessionWindowFetchMock.mockReset();
    waitForRuntimeJobResultMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce({
      snapshot: {
        sessionKey: requestedSessionKey,
        items: [],
        approvals: [],
        replayComplete: true,
        runtime: {
          activeRunId: null,
          runPhase: 'idle',
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          runtimeActivity: null,
          lastUserMessageAt: null,
          lastError: null,
          lastIssue: null,
          updatedAt: null,
        },
        window: {
          totalItemCount: 0,
          windowStartOffset: 0,
          windowEndOffset: 0,
          hasMore: false,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    });

    const result = await fetchHistoryWindow({
      requestedSessionKey,
      sessions: [{ key: requestedSessionKey, updatedAt: 1 }],
      limit: CHAT_HISTORY_FULL_LIMIT,
    });

    expect(hostSessionLoadMock).toHaveBeenCalledWith({
      sessionKey: requestedSessionKey,
      limit: CHAT_HISTORY_FULL_LIMIT,
    }, {
      timeoutMs: undefined,
    });
    expect(result.snapshot?.items).toEqual([]);
    expect(result.totalItemCount).toBe(0);
    expect(result.isAtLatest).toBe(true);
  });
});

