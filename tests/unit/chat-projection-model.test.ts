import { describe, expect, it } from 'vitest';
import { buildHistoryProjectionMessages } from '@/pages/Chat/chat-projection-model';
import type { RawMessage } from '@/stores/chat';

function buildMessage(
  index: number,
  overrides: Partial<RawMessage> = {},
): RawMessage {
  return {
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    timestamp: index,
    id: `msg-${index}`,
    ...overrides,
  };
}

describe('chat projection model', () => {
  it('应只把远端历史缺失的 live 尾部正式消息并入 history 投影', () => {
    const historyBaseMessages = [
      buildMessage(1),
      buildMessage(2),
      buildMessage(3),
    ];
    const liveMessages = [
      buildMessage(1),
      buildMessage(2),
      buildMessage(3),
      buildMessage(4),
      buildMessage(5),
    ];

    const result = buildHistoryProjectionMessages(historyBaseMessages, liveMessages);

    expect(result.committedLiveTailMessages).toEqual([
      buildMessage(4),
      buildMessage(5),
    ]);
    expect(result.mergedMessages).toEqual([
      ...historyBaseMessages,
      buildMessage(4),
      buildMessage(5),
    ]);
  });

  it('一边有 id 一边没 id 时，也不应重复并入同一条消息', () => {
    const historyBaseMessages = [
      buildMessage(1, { id: undefined }),
      buildMessage(2, { id: undefined }),
    ];
    const liveMessages = [
      buildMessage(1),
      buildMessage(2),
      buildMessage(3),
    ];

    const result = buildHistoryProjectionMessages(historyBaseMessages, liveMessages);

    expect(result.committedLiveTailMessages).toEqual([
      buildMessage(3),
    ]);
    expect(result.mergedMessages).toEqual([
      ...historyBaseMessages,
      buildMessage(3),
    ]);
  });

  it('远端历史与 live 语义未变时，应给出稳定 fingerprint', () => {
    const historyBaseMessages = [
      buildMessage(1),
      buildMessage(2),
      buildMessage(3),
    ];
    const liveMessages = [
      buildMessage(1),
      buildMessage(2),
      buildMessage(3),
      buildMessage(4),
    ];

    const first = buildHistoryProjectionMessages(historyBaseMessages, liveMessages);
    const second = buildHistoryProjectionMessages(
      historyBaseMessages.map((message) => ({ ...message })),
      liveMessages.map((message) => ({ ...message })),
    );

    expect(second.historyBaseFingerprint).toBe(first.historyBaseFingerprint);
    expect(second.liveTailFingerprint).toBe(first.liveTailFingerprint);
    expect(second.mergedMessages).toEqual(first.mergedMessages);
  });
});
