import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetGatewayChatEventDedupStateForTest,
  dispatchGatewayProtocolEvent,
  isGatewayEventFrame,
  isGatewayResponseFrame,
} from '../../runtime-host/openclaw-bridge';

describe('gateway protocol guards', () => {
  it('只识别 OpenClaw 响应帧', () => {
    expect(isGatewayResponseFrame({
      type: 'res',
      id: 'req-1',
      ok: true,
      payload: { success: true },
    })).toBe(true);

    expect(isGatewayResponseFrame({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { success: true },
    })).toBe(false);
  });

  it('只识别 OpenClaw 事件帧', () => {
    expect(isGatewayEventFrame({
      type: 'event',
      event: 'chat',
      payload: { text: 'hello' },
    })).toBe(true);

    expect(isGatewayEventFrame({
      type: 'event',
      payload: { text: 'hello' },
    })).toBe(false);
  });
});

describe('dispatchProtocolEvent', () => {
  beforeEach(() => {
    __resetGatewayChatEventDedupStateForTest();
  });

  it('chat 事件缺少 V4 必需字段时不会进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();

    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'chat',
      {
        role: 'assistant',
        content: 'hello',
      },
    );

    expect(emitNotification).not.toHaveBeenCalled();
    expect(emitConversationEvent).not.toHaveBeenCalled();
  });

  it('chat 事件只接受显式 V4 final state', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();

    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'chat',
      {
        state: 'final',
        runId: 'run-final-1',
        sessionKey: 'agent:main:main',
        seq: 1,
        message: {
          role: 'assistant',
          content: 'all done',
        },
      },
    );

    expect(emitConversationEvent).toHaveBeenCalledTimes(1);
    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'chat.message',
      event: expect.objectContaining({
        state: 'final',
        runId: 'run-final-1',
        sessionKey: 'agent:main:main',
        seq: 1,
      }),
    });
  });

  it('连续相同 final chat 事件也应全部下发，不能在 bridge 层按文本语义折叠', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();

    const event = {
      state: 'final',
      runId: 'run-final-2',
      sessionKey: 'agent:main:main',
      seq: 2,
      message: { role: 'assistant', content: 'same final' },
    };

    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'chat',
      event,
    );
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'chat',
      event,
    );

    expect(emitConversationEvent).toHaveBeenCalledTimes(2);
    expect(emitConversationEvent).toHaveBeenNthCalledWith(1, {
      type: 'chat.message',
      event,
    });
    expect(emitConversationEvent).toHaveBeenNthCalledWith(2, {
      type: 'chat.message',
      event,
    });
  });

  it('chat 事件会保留 V4 seq 并拒绝旧 sequenceId fallback', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();

    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'chat',
      {
        state: 'delta',
        runId: 'run-identity-1',
        sessionKey: 'agent:main:main',
        seq: 9,
        agentId: 'agent-main',
        message: {
          role: 'assistant',
          content: 'hello',
        },
      },
    );

    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'chat.message',
      event: expect.objectContaining({
        state: 'delta',
        runId: 'run-identity-1',
        sessionKey: 'agent:main:main',
        seq: 9,
      }),
    });
  });

  it('agent assistant stream 不进入 conversation 通道，assistant 文本只由 chat 事件承载', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'agent',
      {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        stream: 'assistant',
        seq: 4,
        data: {
          text: 'hello',
        },
      },
    );

    expect(emitConversationEvent).not.toHaveBeenCalled();
    expect(emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'agent',
      }),
    );
  });

  it('agent thinking stream 会作为源事实进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'agent',
      {
        runId: 'run-thinking-1',
        sessionKey: 'agent:main:main',
        stream: 'thinking',
        seq: 5,
        ts: 1_700_000_000_010,
        data: {
          text: 'reviewing options',
          delta: 'reviewing options',
        },
      },
    );

    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'thinking.delta',
      event: {
        runId: 'run-thinking-1',
        sessionKey: 'agent:main:main',
        seq: 5,
        timestamp: 1_700_000_000_010,
        text: 'reviewing options',
        delta: 'reviewing options',
      },
    });
    expect(emitNotification).toHaveBeenCalledWith(expect.objectContaining({ method: 'agent' }));
  });

  it('agent native plan stream 当前只透传 notification，不进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'agent',
      {
        runId: 'run-plan-1',
        sessionKey: 'agent:main:main',
        stream: 'plan',
        seq: 6,
        ts: 1_700_000_000_020,
        data: {
          phase: 'update',
          title: 'Assistant proposed a plan',
        },
      },
    );

    expect(emitConversationEvent).not.toHaveBeenCalled();
    expect(emitNotification).toHaveBeenCalledWith(expect.objectContaining({ method: 'agent' }));
  });

  it('session.message 事件会作为 transcript message 事实进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'session.message',
      {
        sessionKey: 'agent:main:main',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '历史消息' }],
        },
      },
    );

    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'session.message',
      event: expect.objectContaining({
        sessionKey: 'agent:main:main',
        message: expect.objectContaining({ role: 'assistant' }),
      }),
    });
    expect(emitNotification).toHaveBeenCalledWith(expect.objectContaining({
      method: 'session.message',
    }));
  });

  it('agent tool stream 会作为 OpenClaw tool lifecycle 进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'agent',
      {
        runId: 'run-tool-1',
        sessionKey: 'agent:main:main',
        stream: 'tool',
        seq: 7,
        ts: 1_700_000_000_000,
        data: {
          phase: 'start',
          toolCallId: 'tool-1',
          name: 'memory_store',
          args: { text: '记住偏好' },
        },
      },
    );

    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'tool.lifecycle',
      event: expect.objectContaining({
        runId: 'run-tool-1',
        sessionKey: 'agent:main:main',
        seq: 7,
        timestamp: 1_700_000_000_000,
        phase: 'start',
        toolCallId: 'tool-1',
        name: 'memory_store',
        args: { text: '记住偏好' },
      }),
    });
  });

  it('session.tool 事件会作为 transcript tool 事实进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'session.tool',
      {
        runId: 'run-tool-2',
        sessionKey: 'agent:main:main',
        stream: 'tool',
        ts: 1_700_000_000_001,
        seq: 8,
        data: {
          phase: 'result',
          toolCallId: 'tool-2',
          name: 'read',
          isError: false,
        },
      },
    );

    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'session.tool',
      event: expect.objectContaining({
        runId: 'run-tool-2',
        sessionKey: 'agent:main:main',
        seq: 8,
        timestamp: 1_700_000_000_001,
        phase: 'result',
        toolCallId: 'tool-2',
        name: 'read',
        isError: false,
      }),
    });
  });

  it('tool stream 缺少 OpenClaw 原生必需字段时不会进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'agent',
      {
        runId: 'run-tool-invalid',
        sessionKey: 'agent:main:main',
        stream: 'tool',
        seq: 1,
        ts: 1_700_000_000_000,
        data: {
          phase: 'started',
          toolCallId: 'tool-invalid',
          name: 'read',
        },
      },
    );

    expect(emitConversationEvent).not.toHaveBeenCalled();
    expect(emitNotification).toHaveBeenCalledWith(expect.objectContaining({
      method: 'agent',
    }));
  });

  it('usage 和 artifact 事件会作为 canonical fact 进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();

    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'usage',
      { sessionKey: 'agent:main:main', usage: { totalTokens: 10 } },
    );
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'artifact',
      { sessionKey: 'agent:main:main', artifact: { id: 'artifact-1' } },
    );

    expect(emitConversationEvent).toHaveBeenNthCalledWith(1, {
      type: 'usage',
      event: { sessionKey: 'agent:main:main', usage: { totalTokens: 10 } },
    });
    expect(emitConversationEvent).toHaveBeenNthCalledWith(2, {
      type: 'artifact',
      event: { sessionKey: 'agent:main:main', artifact: { id: 'artifact-1' } },
    });
    expect(emitNotification).toHaveBeenCalledWith(expect.objectContaining({ method: 'usage' }));
    expect(emitNotification).toHaveBeenCalledWith(expect.objectContaining({ method: 'artifact' }));
  });

  it('agent lifecycle stream 会归一化为 run.phase conversation 事件', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'agent',
      {
        runId: 'run-2',
        sessionKey: 'agent:main:main',
        stream: 'lifecycle',
        data: {
          phase: 'start',
        },
      },
    );

    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'run.phase',
      phase: 'started',
      runId: 'run-2',
      sessionKey: 'agent:main:main',
    });
  });


  it('agent compaction stream 会作为运行态活动进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'agent',
      {
        runId: 'run-compaction-protocol-1',
        sessionKey: 'agent:main:main',
        stream: 'compaction',
        data: {
          phase: 'start',
        },
      },
    );

    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'run.activity',
      activity: 'compacting',
      phase: 'started',
      runId: 'run-compaction-protocol-1',
      sessionKey: 'agent:main:main',
    });
    expect(emitNotification).toHaveBeenCalledWith(expect.objectContaining({
      method: 'agent',
    }));
  });

  it('未知事件只透传 notification', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'exec.approval.requested',
      { id: 'approval-1' },
    );

    expect(emitConversationEvent).not.toHaveBeenCalled();
    expect(emitChannelStatus).not.toHaveBeenCalled();
    expect(emitNotification).toHaveBeenCalledTimes(1);
    expect(emitNotification).toHaveBeenCalledWith({
      method: 'exec.approval.requested',
      params: { id: 'approval-1' },
    });
  });
});
