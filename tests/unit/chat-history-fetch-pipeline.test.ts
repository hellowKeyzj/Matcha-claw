import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_HISTORY_FULL_LIMIT,
  fetchHistoryWindow,
} from '@/stores/chat/history-fetch-helpers';
import type { RawMessage } from './helpers/timeline-fixtures';

const hostSessionLoadMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
  hostSessionLoad: (...args: unknown[]) => hostSessionLoadMock(...args),
}));

describe('chat history fetch pipeline helpers', () => {
  it('returns host session load result directly when adapter already provides timeline entries', async () => {
    const requestedSessionKey = 'agent:main:main';
    const sourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'a', timestamp: 1 },
      { role: 'assistant', content: 'b', timestamp: 2 },
    ];
    hostSessionLoadMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce({
        snapshot: {
          sessionKey: requestedSessionKey,
        entries: sourceMessages.map((message, index) => ({
          entryId: `entry-${index + 1}`,
          sessionKey: requestedSessionKey,
          laneKey: 'main',
          turnKey: `main:entry-${index + 1}`,
          role: message.role,
          status: 'final',
          text: typeof message.content === 'string' ? message.content : '',
          message,
        })),
        replayComplete: true,
        runtime: {
          sending: false,
          activeRunId: null,
          runPhase: 'idle',
          streamingMessageId: null,
          pendingFinal: false,
          lastUserMessageAt: null,
          updatedAt: null,
        },
        window: {
          totalEntryCount: sourceMessages.length,
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
      totalMessageCount: sourceMessages.length,
      windowStartOffset: 0,
      windowEndOffset: sourceMessages.length,
    }));
    expect(result.snapshot?.entries).toMatchObject([
      {
        message: {
          role: 'assistant',
          content: 'a',
          timestamp: 1,
        },
        entryId: 'entry-1',
        laneKey: 'main',
        turnKey: 'main:entry-1',
      },
      {
        message: {
          role: 'assistant',
          content: 'b',
          timestamp: 2,
        },
        entryId: 'entry-2',
        laneKey: 'main',
        turnKey: 'main:entry-2',
      },
    ]);
  });

  it('does not fall back to gateway history for normal sessions when adapter returns empty replay', async () => {
    const requestedSessionKey = 'agent:test:session-1';
    hostSessionLoadMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce({
      snapshot: {
        sessionKey: requestedSessionKey,
        entries: [],
        replayComplete: true,
        runtime: {
          sending: false,
          activeRunId: null,
          runPhase: 'idle',
          streamingMessageId: null,
          pendingFinal: false,
          lastUserMessageAt: null,
          updatedAt: null,
        },
        window: {
          totalEntryCount: 0,
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
    expect(result.snapshot?.entries).toEqual([]);
    expect(result.totalMessageCount).toBe(0);
    expect(result.isAtLatest).toBe(true);
  });
});

