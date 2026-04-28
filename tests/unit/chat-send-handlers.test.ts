import { describe, expect, it } from 'vitest';
import { applyStoreSendStart, buildPendingUserMessageOverlay } from '@/stores/chat/send-handlers';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

function createSessionRecord(input?: {
  transcript?: RawMessage[];
}) {
  return {
    transcript: input?.transcript ?? [],
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
      assistantOverlay: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
    },
  };
}

describe('chat send handlers', () => {
  it('stores pending user overlay, writes it into viewport, and keeps canonical transcript clean', () => {
    const sessionKey = 'agent:main:session-1';
    const nowMs = 1_700_000_000_000;
    const pendingUserMessage = buildPendingUserMessageOverlay({
      clientMessageId: 'user-local-1',
      text: 'hello world',
      nowMs,
    });

    let state = {
      currentSessionKey: sessionKey,
      sessionsByKey: {
        [sessionKey]: createSessionRecord(),
      },
      viewportBySession: {
        [sessionKey]: createViewportWindowState(),
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

    const record = state.sessionsByKey[sessionKey]!;
    expect(record.transcript).toEqual([]);
    expect(record.meta.label).toBe('hello world');
    expect(record.runtime.pendingUserMessage).toEqual(pendingUserMessage);
    expect(record.runtime.lastUserMessageAt).toBe(nowMs);
    expect(state.viewportBySession[sessionKey]?.messages.map((message) => message.id)).toEqual(['user-local-1']);
  });
});
