import { describe, expect, it } from 'vitest';
import {
  createInitialChatScrollState,
  reduceChatScrollState,
  shouldExecuteChatScrollCommand,
} from '@/pages/Chat/chat-scroll-machine';

describe('chat scroll machine', () => {
  it('切会话后应进入 opening，并保留 open-to-latest 命令直到确认完成', () => {
    const initial = createInitialChatScrollState({
      sessionKey: 'agent:main:main',
      lastRowKey: 'row-3',
      rowCount: 3,
    });

    const switched = reduceChatScrollState(initial, {
      type: 'SESSION_SWITCHED',
      sessionKey: 'agent:another:main',
      lastRowKey: 'row-9',
      rowCount: 3,
    });

    expect(switched.mode).toBe('opening');
    expect(switched.command.type).toBe('open-to-latest');
    expect(switched.command.targetRowCount).toBe(3);
    expect(shouldExecuteChatScrollCommand(switched)).toBe(false);

    const viewportReady = reduceChatScrollState(switched, {
      type: 'VIEWPORT_READY_CHANGED',
      ready: true,
    });

    expect(shouldExecuteChatScrollCommand(viewportReady)).toBe(true);

    const settled = reduceChatScrollState(viewportReady, {
      type: 'BOTTOM_REACHED',
    });

    expect(settled.mode).toBe('sticky');
    expect(settled.command.type).toBe('none');
  });

  it('sticky 状态下末尾追加消息，应生成 follow-append 命令；用户主动上翻后应清掉命令', () => {
    const initial = createInitialChatScrollState({
      sessionKey: 'agent:main:main',
      lastRowKey: 'row-3',
      rowCount: 3,
    });

    const sticky = reduceChatScrollState(initial, {
      type: 'BOTTOM_REACHED',
    });

    const appended = reduceChatScrollState(sticky, {
      type: 'ROWS_CHANGED',
      lastRowKey: 'row-4',
      rowCount: 4,
    });

    expect(appended.mode).toBe('sticky');
    expect(appended.command.type).toBe('follow-append');
    expect(appended.command.targetRowCount).toBe(4);

    const scrolledAway = reduceChatScrollState(appended, {
      type: 'VIEWPORT_POSITION_CHANGED',
      isNearBottom: false,
    });

    expect(scrolledAway.mode).toBe('sticky');
    expect(scrolledAway.command.type).toBe('follow-append');

    const detached = reduceChatScrollState(scrolledAway, {
      type: 'USER_DETACHED',
    });

    expect(detached.mode).toBe('detached');
    expect(detached.command.type).toBe('none');
  });

  it('命令待消费时，程序化滚动产生的中间位置变化不应提前清掉 open-to-latest', () => {
    const initial = createInitialChatScrollState({
      sessionKey: 'agent:main:main',
      lastRowKey: 'row-3',
      rowCount: 3,
    });

    const pending = reduceChatScrollState(initial, {
      type: 'VIEWPORT_READY_CHANGED',
      ready: true,
    });

    const intermediate = reduceChatScrollState(pending, {
      type: 'VIEWPORT_POSITION_CHANGED',
      isNearBottom: false,
    });

    expect(intermediate.mode).toBe('opening');
    expect(intermediate.command.type).toBe('open-to-latest');
    expect(shouldExecuteChatScrollCommand(intermediate)).toBe(true);
  });
});
