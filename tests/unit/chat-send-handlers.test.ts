import { describe, expect, it } from 'vitest';
import { applyStoreSendStart, buildLocalUserMessage } from '@/stores/chat/send-handlers';
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
      streamingMessageId: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
    },
    messages: input?.messages ?? [],
    window: createViewportWindowState({
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
  it('stores local sending user message in the session transcript', () => {
    const sessionKey = 'agent:main:session-1';
    const nowMs = 1_700_000_000_000;
    const localUserMessage = buildLocalUserMessage({
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
      localUserMessage,
      nowMs,
    });

    const record = state.loadedSessions[sessionKey]!;
    expect(record.meta.label).toBe('hello world');
    expect(record.runtime.lastUserMessageAt).toBe(nowMs);
    expect(record.messages.map((message) => message.id)).toEqual(['user-local-1']);
    expect(record.messages[0]?.status).toBe('sending');
  });

  it('detached viewport send aligns the visible window back to the latest slice inside store', () => {
    const sessionKey = 'agent:main:session-1';
    const nowMs = 1_700_000_000_000;
    const existingMessages = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message ${index + 1}`,
      timestamp: index + 1,
    }));
    const localUserMessage = buildLocalUserMessage({
      clientMessageId: 'user-local-21',
      text: 'latest reply',
      nowMs,
    });

    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: {
          ...createSessionRecord({ messages: existingMessages }),
          window: createViewportWindowState({
            totalMessageCount: 20,
            windowStartOffset: 0,
            windowEndOffset: 10,
            hasMore: false,
            hasNewer: true,
            isAtLatest: false,
          }),
        },
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
      localUserMessage,
      nowMs,
    });

    const record = state.loadedSessions[sessionKey]!;
    expect(record.window.windowStartOffset).toBe(11);
    expect(record.window.windowEndOffset).toBe(21);
    expect(record.window.hasNewer).toBe(false);
    expect(record.window.isAtLatest).toBe(true);
    expect(record.messages.at(-1)?.id).toBe('user-local-21');
  });
});
