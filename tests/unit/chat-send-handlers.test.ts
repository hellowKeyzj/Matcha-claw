import { describe, expect, it } from 'vitest';
import { applyStoreSendStart, buildPendingUserMessageOverlay } from '@/stores/chat/send-handlers';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

function createSessionRecord(input?: {
  messages?: RawMessage[];
}) {
  return {
    meta: {
      label: null,
      lastActivityAt: null,
      ready: true,
      thinkingLevel: null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      pendingUserMessage: null,
      streamingMessageId: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
    },
    window: createViewportWindowState({
      messages: input?.messages ?? [],
      totalMessageCount: input?.messages?.length ?? 0,
      windowStartOffset: 0,
      windowEndOffset: input?.messages?.length ?? 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }),
  };
}

describe('chat send handlers', () => {
  it('stores pending user overlay and appends it into the active session window', () => {
    const sessionKey = 'agent:main:session-1';
    const nowMs = 1_700_000_000_000;
    const pendingUserMessage = buildPendingUserMessageOverlay({
      clientMessageId: 'user-local-1',
      text: 'hello world',
      nowMs,
    });

    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord(),
      },
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };

    applyStoreSendStart({
      set,
      sessionKey,
      pendingUserMessage,
      nowMs,
    });

    const record = state.loadedSessions[sessionKey]!;
    expect(record.meta.label).toBe('hello world');
    expect(record.runtime.pendingUserMessage).toEqual(pendingUserMessage);
    expect(record.runtime.lastUserMessageAt).toBe(nowMs);
    expect(record.window.messages.map((message) => message.id)).toEqual(['user-local-1']);
  });
});

