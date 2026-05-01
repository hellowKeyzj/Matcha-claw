import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_HISTORY_FULL_LIMIT,
  fetchHistoryWindow,
} from '@/stores/chat/history-fetch-helpers';
import { useGatewayStore } from '@/stores/gateway';
import type { RawMessage } from '@/stores/chat/types';

const hostSessionWindowFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
  hostSessionWindowFetch: (...args: unknown[]) => hostSessionWindowFetchMock(...args),
}));

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

    const result = await fetchHistoryWindow({
      requestedSessionKey,
      sessions: [{ key: requestedSessionKey, updatedAt: 1 }],
      limit: CHAT_HISTORY_FULL_LIMIT,
    });

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

  it('returns host session window directly when host already provides latest rows', async () => {
    const requestedSessionKey = 'agent:main:main';
    const rawMessages: RawMessage[] = [
      { role: 'assistant', content: 'a', timestamp: 1 },
      { role: 'assistant', content: 'b', timestamp: 2 },
    ];
    hostSessionWindowFetchMock.mockReset();
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: rawMessages,
      canonicalMessages: rawMessages,
      totalMessageCount: rawMessages.length,
      windowStartOffset: 0,
      windowEndOffset: rawMessages.length,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    });
    const rpcMock = vi.fn(async () => ({}));
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    const result = await fetchHistoryWindow({
      requestedSessionKey,
      sessions: [{ key: requestedSessionKey, thinkingLevel: 'medium', updatedAt: 1 }],
      limit: CHAT_HISTORY_FULL_LIMIT,
    });

    expect(result).toEqual(expect.objectContaining({
      rawMessages,
      thinkingLevel: 'medium',
      totalMessageCount: rawMessages.length,
      windowStartOffset: 0,
      windowEndOffset: rawMessages.length,
    }));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
