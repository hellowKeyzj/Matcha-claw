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

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
  hostSessionLoad: (...args: unknown[]) => hostSessionLoadMock(...args),
}));

describe('chat history fetch pipeline helpers', () => {
  it('returns host session load result directly when adapter already provides render items', async () => {
    const requestedSessionKey = 'agent:main:main';
    const sourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'a', timestamp: 1 },
      { role: 'assistant', content: 'b', timestamp: 2 },
    ];
    hostSessionLoadMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce({
      snapshot: {
        sessionKey: requestedSessionKey,
        items: buildRenderItemsFromMessages(requestedSessionKey, sourceMessages),
        replayComplete: true,
        runtime: {
          sending: false,
          activeRunId: null,
          runPhase: 'idle',
          streamingAnchorKey: null,
          pendingFinal: false,
          lastUserMessageAt: null,
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

  it('does not fall back to gateway history for normal sessions when adapter returns empty replay', async () => {
    const requestedSessionKey = 'agent:test:session-1';
    hostSessionLoadMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce({
      snapshot: {
        sessionKey: requestedSessionKey,
        items: [],
        replayComplete: true,
        runtime: {
          sending: false,
          activeRunId: null,
          runPhase: 'idle',
          streamingAnchorKey: null,
          pendingFinal: false,
          lastUserMessageAt: null,
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
    });
    expect(result.snapshot?.items).toEqual([]);
    expect(result.totalItemCount).toBe(0);
    expect(result.isAtLatest).toBe(true);
  });
});

