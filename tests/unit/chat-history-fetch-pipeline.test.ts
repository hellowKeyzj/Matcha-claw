import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_HISTORY_FULL_LIMIT,
  decodeHistorySessionView,
  fetchHistoryWindow,
} from '@/stores/chat/history-fetch-helpers';
import { projectSessionViewItems } from '@/stores/chat/store-state-helpers';
import {
  assistantItem,
  completeFact,
  sessionView,
  userItem,
  windowView,
} from './helpers/session-fixtures';
import { buildSessionRecordKey } from '@/stores/chat/session-identity';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

const hostSessionLoadMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionLoad: (...args: unknown[]) => hostSessionLoadMock(...args),
}));

describe('chat history fetch pipeline helpers', () => {
  it('projects a canonical SessionView with identity, cursor facts, and item identity', () => {
    const sessionKey = 'agent:main:main';
    const view = sessionView(sessionKey, {
      epoch: 3,
      seq: 4,
      cursor: 4,
      items: completeFact([
        userItem('item-user-1', 'hello'),
        assistantItem('item-assistant-1', 'hi', { runId: 'run-1' }),
      ]),
      window: completeFact(windowView(2)),
    });

    expect(view).toMatchObject({
      sessionKey,
      identity: { sessionKey, endpoint: { runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } },
      epoch: 3,
      seq: 4,
      cursor: 4,
      completeness: 'complete',
    });
    expect(projectSessionViewItems(view)).toMatchObject([
      {
        key: 'item-user-1',
        kind: 'user-message',
        text: 'hello',
        messageId: 'item-user-1',
      },
      {
        key: 'item-assistant-1',
        kind: 'assistant-turn',
        text: 'hi',
        runId: 'run-1',
        status: 'final',
        thinking: null,
        tools: [],
        segments: [{ kind: 'message', text: 'hi' }],
      },
    ]);
  });

  it('uses the canonical SessionView and preserves its window', async () => {
    const requestedSessionKey = 'agent:main:main';
    const identity = createOpenClawTestSessionIdentity(requestedSessionKey);
    const view = sessionView(requestedSessionKey, {
      identity,
      epoch: 7,
      seq: 9,
      cursor: 11,
      items: completeFact([assistantItem('item-assistant-1', 'loaded')]),
      window: completeFact(windowView(4, {
        windowStartOffset: 2,
        windowEndOffset: 3,
        hasMore: true,
        hasNewer: false,
        isAtLatest: false,
      })),
    });
    hostSessionLoadMock.mockReset();
    hostSessionLoadMock.mockResolvedValueOnce(view);

    const recordKey = buildSessionRecordKey(identity);
    const result = await fetchHistoryWindow({
      recordKey,
      sessionIdentity: identity,
      sessions: [{ key: recordKey, thinkingLevel: 'medium', updatedAt: 1 }],
      limit: CHAT_HISTORY_FULL_LIMIT,
    });

    expect(hostSessionLoadMock).toHaveBeenCalledWith({
      sessionIdentity: identity,
      limit: CHAT_HISTORY_FULL_LIMIT,
    }, { timeoutMs: undefined, traceId: undefined });
    expect(result.thinkingLevel).toBe('medium');
    expect(result.view).toMatchObject({ epoch: 7, seq: 9, cursor: 11 });
    expect(projectSessionViewItems(result.view)).toMatchObject([{ kind: 'assistant-turn', text: 'loaded' }]);
    expect(result.view.window).toEqual(expect.objectContaining({
      complete: expect.objectContaining({ totalItemCount: 4, windowStartOffset: 2, windowEndOffset: 3 }),
    }));
  });

  it('accepts an explicitly incomplete SessionView while rejecting unavailable completeness', () => {
    const requestedSessionKey = 'agent:test:session-1';
    const incomplete = sessionView(requestedSessionKey, {
      completeness: { incomplete: { missing: ['bounded_history'] } },
      items: { incomplete: { facts: [], gaps: ['bounded_history'] } },
      window: { incomplete: { facts: windowView(0), gaps: ['bounded_history'] } },
    });

    expect(decodeHistorySessionView(incomplete)).toMatchObject({
      sessionKey: requestedSessionKey,
      completeness: { incomplete: { missing: ['bounded_history'] } },
    });
    expect(() => decodeHistorySessionView({ ...incomplete, completeness: 'unavailable' })).toThrow(
      'Session view is unavailable',
    );
  });
});
