import { describe, expect, it } from 'vitest';
import { buildChatAutoFollowSignal } from '@/pages/Chat/chat-auto-follow';
import { applyAssistantPresentationToItems, type ChatRenderItem } from '@/pages/Chat/chat-render-item-model';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

function buildMessageItem(id: string, role: 'user' | 'assistant', content: string, timestamp = 1): ChatRenderItem {
  return applyAssistantPresentationToItems({
    items: buildRenderItemsFromMessages('agent:test:main', [{
      id,
      role,
      content,
      timestamp,
    }]),
    agents: [],
    defaultAssistant: null,
  })[0]!;
}

describe('chat auto follow signal', () => {
  it('keeps the same signal when assistant handoff keeps the same committed tail row', () => {
    const streamingItems: ChatRenderItem[] = [
      buildMessageItem('user-1', 'user', 'hello'),
      buildMessageItem('assistant-1', 'assistant', 'first chunk', 2),
    ];
    const finalItems: ChatRenderItem[] = [...streamingItems];

    expect(buildChatAutoFollowSignal(finalItems)).toBe(
      buildChatAutoFollowSignal(streamingItems),
    );
  });

  it('keeps the same signal when the same tail message only grows in text length', () => {
    const previousItems = [buildMessageItem('assistant-1', 'assistant', 'hello')];
    const nextItems = [buildMessageItem('assistant-1', 'assistant', 'hello world')];

    expect(buildChatAutoFollowSignal(nextItems)).toBe(
      buildChatAutoFollowSignal(previousItems),
    );
  });

  it('changes the signal when the tail message transitions from empty to non-empty', () => {
    const previousItems = [buildMessageItem('assistant-1', 'assistant', '')];
    const nextItems = [buildMessageItem('assistant-1', 'assistant', 'hello world')];

    expect(buildChatAutoFollowSignal(nextItems)).not.toBe(
      buildChatAutoFollowSignal(previousItems),
    );
  });

  it('changes the signal when a new tail row is appended', () => {
    const previousItems: ChatRenderItem[] = [
      buildMessageItem('user-1', 'user', 'hello'),
    ];
    const nextItems: ChatRenderItem[] = [
      ...previousItems,
      buildMessageItem('assistant-1', 'assistant', 'world', 2),
    ];

    expect(buildChatAutoFollowSignal(nextItems)).not.toBe(
      buildChatAutoFollowSignal(previousItems),
    );
  });

  it('changes the signal when the tail row key changes even if row count stays the same', () => {
    const previousItems = [buildMessageItem('assistant-1', 'assistant', 'hello')];
    const nextItems = [buildMessageItem('assistant-2', 'assistant', 'hello')];

    expect(buildChatAutoFollowSignal(nextItems)).not.toBe(
      buildChatAutoFollowSignal(previousItems),
    );
  });

  it('only tracks the message tail, not its text growth state outside empty/non-empty transition', () => {
    const previousItems = [buildMessageItem('assistant-1', 'assistant', 'hello')];
    const nextItems = [buildMessageItem('assistant-1', 'assistant', 'hello world hello world')];

    expect(buildChatAutoFollowSignal(nextItems)).toBe(
      buildChatAutoFollowSignal(previousItems),
    );
  });
});

