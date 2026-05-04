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
  it('returns host session load result directly when adapter already provides rows', async () => {
    const requestedSessionKey = 'agent:main:main';
    const sourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'a', timestamp: 1 },
      { role: 'assistant', content: 'b', timestamp: 2 },
    ];
    hostSessionLoadMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce({
      snapshot: {
        sessionKey: requestedSessionKey,
        rows: sourceMessages.map((message, index) => ({
          key: `session:${requestedSessionKey}|row:row-${index + 1}`,
          kind: 'message',
          sessionKey: requestedSessionKey,
          laneKey: 'main',
          turnKey: `main:row-${index + 1}`,
          role: 'assistant',
          status: 'final',
          text: typeof message.content === 'string' ? message.content : '',
          thinking: null,
          images: [],
          toolUses: [],
          attachedFiles: [],
          toolStatuses: [],
          isStreaming: false,
          rowId: `row-${index + 1}`,
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
          totalRowCount: sourceMessages.length,
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
      totalRowCount: sourceMessages.length,
      windowStartOffset: 0,
      windowEndOffset: sourceMessages.length,
    }));
    expect(result.snapshot?.rows).toMatchObject([
      {
        rowId: 'row-1',
        role: 'assistant',
        text: 'a',
        laneKey: 'main',
        turnKey: 'main:row-1',
      },
      {
        rowId: 'row-2',
        role: 'assistant',
        text: 'b',
        laneKey: 'main',
        turnKey: 'main:row-2',
      },
    ]);
  });

  it('does not fall back to gateway history for normal sessions when adapter returns empty replay', async () => {
    const requestedSessionKey = 'agent:test:session-1';
    hostSessionLoadMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce({
      snapshot: {
        sessionKey: requestedSessionKey,
        rows: [],
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
          totalRowCount: 0,
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
    expect(result.snapshot?.rows).toEqual([]);
    expect(result.totalRowCount).toBe(0);
    expect(result.isAtLatest).toBe(true);
  });
});

