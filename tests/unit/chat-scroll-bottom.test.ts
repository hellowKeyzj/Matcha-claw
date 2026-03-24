import { describe, expect, it, vi } from 'vitest';
import { scrollChatToBottom, shouldAutoScrollChat } from '@/pages/Chat';

describe('chat 虚拟列表吸底 helper', () => {
  it('有历史消息时，应先滚到最后一条再对底部锚点做兜底滚动', () => {
    const scrollToIndex = vi.fn();
    const scrollIntoView = vi.fn();

    scrollChatToBottom(2, { scrollToIndex }, { current: { scrollIntoView } as unknown as HTMLDivElement });

    expect(scrollToIndex).toHaveBeenCalledWith(1, { align: 'end' });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto' });
  });

  it('没有历史消息时，不应调用虚拟列表滚动，但仍保留底部锚点兜底', () => {
    const scrollToIndex = vi.fn();
    const scrollIntoView = vi.fn();

    scrollChatToBottom(0, { scrollToIndex }, { current: { scrollIntoView } as unknown as HTMLDivElement });

    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto' });
  });
});

describe('chat 自动吸底判定', () => {
  it('用户已离开底部时，不应自动吸底', () => {
    expect(shouldAutoScrollChat(false, null, 'agent:main:main')).toBe(false);
  });

  it('会话仍在恢复滚动位置时，不应抢先执行自动吸底', () => {
    expect(shouldAutoScrollChat(true, 'agent:main:main', 'agent:main:main')).toBe(false);
  });

  it('当前会话没有待恢复滚动时，允许自动吸底', () => {
    expect(shouldAutoScrollChat(true, null, 'agent:main:main')).toBe(true);
  });

  it('其它会话在恢复滚动时，不应阻塞当前会话自动吸底', () => {
    expect(shouldAutoScrollChat(true, 'agent:other:main', 'agent:main:main')).toBe(true);
  });
});
