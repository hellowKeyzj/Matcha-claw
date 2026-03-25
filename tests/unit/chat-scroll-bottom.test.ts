import { describe, expect, it } from 'vitest';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import { buildChatRows } from '@/pages/Chat/chat-row-model';
import {
  createInitialChatScrollState,
  reduceChatScrollState,
  shouldExecuteChatScrollCommand,
} from '@/pages/Chat/chat-scroll-machine';
import { isChatViewportNearBottom } from '@/pages/Chat/useChatScrollOrchestrator';

describe('chat 行模型', () => {
  it('应把历史消息和流式消息合成统一的聊天行列表', () => {
    const rows = buildChatRows({
      sessionKey: 'agent:main:main',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '你好',
          timestamp: 1,
        } satisfies RawMessage,
      ],
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: {
        role: 'assistant',
        content: '在，有事儿吗？',
        timestamp: 2,
      },
      streamingTools: [],
      streamingTimestamp: 2,
    });

    expect(rows.map((row) => row.kind)).toEqual(['message', 'streaming']);
    expect(rows.at(-1)?.key).toBe('streaming:agent:main:main');
  });

  it('只有处理中提示时，应把它作为 activity 行加入虚拟列表', () => {
    const rows = buildChatRows({
      sessionKey: 'agent:main:main',
      messages: [],
      sending: true,
      pendingFinal: true,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'activity', key: 'activity:agent:main:main' });
  });

  it('只有打字提示时，应把它作为 typing 行加入虚拟列表', () => {
    const rows = buildChatRows({
      sessionKey: 'agent:main:main',
      messages: [],
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: null,
      streamingTools: [] satisfies ToolStatus[],
      streamingTimestamp: 0,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'typing', key: 'typing:agent:main:main' });
  });
});

describe('chat 打开与吸底命令', () => {
  it('新打开会话时，应生成 open-to-latest 命令并等待视口 ready', () => {
    const initial = createInitialChatScrollState({
      sessionKey: 'agent:main:main',
      lastRowKey: 'row-2',
      rowCount: 2,
    });

    expect(initial.mode).toBe('opening');
    expect(initial.command).toEqual({
      type: 'open-to-latest',
      targetRowKey: 'row-2',
      targetRowCount: 2,
    });
    expect(shouldExecuteChatScrollCommand(initial)).toBe(false);

    const ready = reduceChatScrollState(initial, {
      type: 'VIEWPORT_READY_CHANGED',
      ready: true,
    });

    expect(shouldExecuteChatScrollCommand(ready)).toBe(true);
  });

  it('底部附近追加消息时，应继续生成 follow-append 命令', () => {
    const sticky = reduceChatScrollState(
      createInitialChatScrollState({
        sessionKey: 'agent:main:main',
        lastRowKey: 'row-1',
        rowCount: 1,
      }),
      { type: 'BOTTOM_REACHED' },
    );

    const appended = reduceChatScrollState(sticky, {
      type: 'ROWS_CHANGED',
      lastRowKey: 'row-2',
      rowCount: 2,
    });

    expect(appended.mode).toBe('sticky');
    expect(appended.command).toEqual({
      type: 'follow-append',
      targetRowKey: 'row-2',
      targetRowCount: 2,
    });
  });

  it('程序化滚动经过旧位置时，不应把打开命令误清掉', () => {
    const pending = reduceChatScrollState(
      createInitialChatScrollState({
        sessionKey: 'agent:main:main',
        lastRowKey: 'row-3',
        rowCount: 3,
      }),
      {
        type: 'VIEWPORT_READY_CHANGED',
        ready: true,
      },
    );

    const scrolledPastOldPosition = reduceChatScrollState(pending, {
      type: 'VIEWPORT_POSITION_CHANGED',
      isNearBottom: false,
    });

    expect(scrolledPastOldPosition.command.type).toBe('open-to-latest');
    expect(scrolledPastOldPosition.mode).toBe('opening');
  });
});

describe('chat 底部阈值判断', () => {
  it('距离底部小于阈值时，应视为仍在底部附近', () => {
    expect(isChatViewportNearBottom({
      scrollHeight: 1000,
      scrollTop: 560,
      clientHeight: 320,
    }, 120)).toBe(true);
  });

  it('距离底部超过阈值时，应视为用户已离开底部', () => {
    expect(isChatViewportNearBottom({
      scrollHeight: 1000,
      scrollTop: 400,
      clientHeight: 320,
    }, 120)).toBe(false);
  });
});
