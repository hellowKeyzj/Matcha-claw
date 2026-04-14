import { describe, expect, it } from 'vitest';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import {
  appendRuntimeChatRows,
  buildChatRows,
  buildStaticChatRows,
  type ExecutionGraphData,
} from '@/pages/Chat/chat-row-model';
import {
  createInitialChatScrollState,
  reduceChatScrollState,
  shouldExecuteChatScrollCommand,
} from '@/pages/Chat/chat-scroll-machine';
import {
  computeBottomLockedScrollTopOnResize,
  isChatViewportNearBottom,
} from '@/pages/Chat/useChatScrollOrchestrator';

describe('chat 行模型', () => {
  it('运行态无附加行时，应复用静态行引用避免额外重建', () => {
    const baseRows = buildStaticChatRows({
      sessionKey: 'agent:main:main',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'hello',
          timestamp: 1,
        } satisfies RawMessage,
      ],
      executionGraphs: [],
    });

    const rows = appendRuntimeChatRows({
      sessionKey: 'agent:main:main',
      baseRows,
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    });

    expect(rows).toBe(baseRows);
    expect(rows.map((row) => row.kind)).toEqual(['message']);
  });

  it('运行态有 streaming 行时，应返回新数组并追加 transient 行', () => {
    const baseRows = buildStaticChatRows({
      sessionKey: 'agent:main:main',
      messages: [],
      executionGraphs: [],
    });

    const rows = appendRuntimeChatRows({
      sessionKey: 'agent:main:main',
      baseRows,
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: {
        role: 'assistant',
        content: 'streaming response',
        timestamp: 2,
      },
      streamingTools: [],
      streamingTimestamp: 2,
    });

    expect(rows).not.toBe(baseRows);
    expect(rows.map((row) => row.kind)).toEqual(['streaming']);
  });

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
    expect(rows.at(-1)?.key).toBe('runtime:agent:main:main');
  });

  it('不同会话里相同 message.id 的行 key 必须隔离，避免虚拟列表缓存串会话', () => {
    const sameMessage: RawMessage = {
      id: 'shared-id',
      role: 'assistant',
      content: 'same id',
      timestamp: 1,
    };
    const rowsA = buildChatRows({
      sessionKey: 'agent:a:main',
      messages: [sameMessage],
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    });
    const rowsB = buildChatRows({
      sessionKey: 'agent:b:main',
      messages: [sameMessage],
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    });

    expect(rowsA[0]?.key).toBe('session:agent:a:main|id:shared-id');
    expect(rowsB[0]?.key).toBe('session:agent:b:main|id:shared-id');
    expect(rowsA[0]?.key).not.toBe(rowsB[0]?.key);
  });

  it('无 id 消息在 history 对象替换后应保持稳定 key，避免虚拟列表闪跳', () => {
    const firstRows = buildChatRows({
      sessionKey: 'agent:main:main',
      messages: [
        {
          role: 'assistant',
          content: '同一条历史消息',
          timestamp: 123,
        } satisfies RawMessage,
      ],
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    });

    const secondRows = buildChatRows({
      sessionKey: 'agent:main:main',
      messages: [
        {
          role: 'assistant',
          content: '同一条历史消息',
          timestamp: 123,
        } satisfies RawMessage,
      ],
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    });

    expect(firstRows[0]?.key).toBe(secondRows[0]?.key);
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
    expect(rows[0]).toMatchObject({ kind: 'activity', key: 'runtime:agent:main:main' });
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
    expect(rows[0]).toMatchObject({ kind: 'typing', key: 'runtime:agent:main:main' });
  });

  it('有执行图时，应在锚点消息后插入 execution_graph 行', () => {
    const sessionKey = 'agent:main:main';
    const graph: ExecutionGraphData = {
      id: 'graph-1',
      anchorMessageKey: `session:${sessionKey}|id:user-1`,
      triggerMessageKey: `session:${sessionKey}|id:user-1`,
      replyMessageKey: `session:${sessionKey}|id:assistant-1`,
      agentLabel: 'coder',
      sessionLabel: 'agent:coder:subagent:child-1',
      steps: [
        {
          id: 'step-1',
          label: 'sessions_spawn',
          status: 'completed',
          kind: 'tool',
          depth: 1,
        },
      ],
      active: false,
    };

    const rows = buildChatRows({
      sessionKey,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '开始任务',
          timestamp: 1,
        } satisfies RawMessage,
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '完成了',
          timestamp: 2,
        } satisfies RawMessage,
      ],
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: true,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
      executionGraphs: [graph],
    });

    expect(rows.map((row) => row.kind)).toEqual(['message', 'execution_graph', 'message']);
    expect(rows[1]).toMatchObject({ kind: 'execution_graph', key: 'execution_graph:graph-1' });
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

  it('行数不变但内容高度变化时，sticky 模式应生成 follow-resize 命令', () => {
    const sticky = reduceChatScrollState(
      createInitialChatScrollState({
        sessionKey: 'agent:main:main',
        lastRowKey: 'row-2',
        rowCount: 2,
      }),
      { type: 'BOTTOM_REACHED' },
    );

    const resized = reduceChatScrollState(sticky, {
      type: 'CONTENT_RESIZED',
    });

    expect(resized.mode).toBe('sticky');
    expect(resized.command).toEqual({
      type: 'follow-resize',
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
      atMs: 1_000,
    });

    expect(scrolledPastOldPosition.command.type).toBe('open-to-latest');
    expect(scrolledPastOldPosition.mode).toBe('opening');
  });

  it('程序滚动执行中，即使存在用户滚动意图也不应误脱底', () => {
    const sticky = reduceChatScrollState(
      createInitialChatScrollState({
        sessionKey: 'agent:main:main',
        lastRowKey: 'row-3',
        rowCount: 3,
      }),
      { type: 'BOTTOM_REACHED' },
    );

    const appended = reduceChatScrollState(sticky, {
      type: 'ROWS_CHANGED',
      lastRowKey: 'row-4',
      rowCount: 4,
    });
    const withIntent = reduceChatScrollState(appended, {
      type: 'USER_SCROLL_INTENT',
      atMs: 1_000,
    });
    const inFlight = reduceChatScrollState(withIntent, {
      type: 'COMMAND_EXECUTION_STARTED',
    });
    const moved = reduceChatScrollState(inFlight, {
      type: 'VIEWPORT_POSITION_CHANGED',
      isNearBottom: false,
      atMs: 1_050,
    });

    expect(moved.mode).toBe('sticky');
    expect(moved.command.type).toBe('follow-append');
    expect(moved.programmaticScrollInFlight).toBe(true);
  });

  it('用户主动上滑时应进入 detached', () => {
    const sticky = reduceChatScrollState(
      createInitialChatScrollState({
        sessionKey: 'agent:main:main',
        lastRowKey: 'row-3',
        rowCount: 3,
      }),
      { type: 'BOTTOM_REACHED' },
    );
    const withIntent = reduceChatScrollState(sticky, {
      type: 'USER_SCROLL_INTENT',
      atMs: 1_000,
    });
    const detached = reduceChatScrollState(withIntent, {
      type: 'VIEWPORT_POSITION_CHANGED',
      isNearBottom: false,
      atMs: 1_050,
    });

    expect(detached.mode).toBe('detached');
    expect(detached.command.type).toBe('none');
    expect(detached.programmaticScrollInFlight).toBe(false);
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

describe('chat resize 底部锚点补偿', () => {
  it('内容高度上涨时，应按增量补偿 scrollTop 以保持吸底', () => {
    const nextTop = computeBottomLockedScrollTopOnResize(
      { scrollHeight: 1000, clientHeight: 320 },
      { scrollHeight: 1140, clientHeight: 320 },
      680,
    );
    expect(nextTop).toBe(820);
  });

  it('视口高度变化时，应同时考虑 clientHeight 差值', () => {
    const nextTop = computeBottomLockedScrollTopOnResize(
      { scrollHeight: 1200, clientHeight: 400 },
      { scrollHeight: 1260, clientHeight: 360 },
      800,
    );
    // delta = +60 - (-40) = +100
    expect(nextTop).toBe(900);
  });

  it('变化不足阈值时，不应触发补偿', () => {
    const nextTop = computeBottomLockedScrollTopOnResize(
      { scrollHeight: 1000, clientHeight: 320 },
      { scrollHeight: 1000.2, clientHeight: 320 },
      680,
    );
    expect(nextTop).toBeNull();
  });
});
