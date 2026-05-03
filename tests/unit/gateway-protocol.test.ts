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

  it('chat 事件无明确终态字段时，会归一化为结构化 delta 再下发', () => {
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
    expect(emitConversationEvent).toHaveBeenCalledTimes(1);
    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'chat.message',
      event: {
        state: 'delta',
        message: { role: 'assistant', content: 'hello' },
      },
    });
  });

  it('chat 事件包含 stopReason 时，应归一化为 final', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();

    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'chat',
      {
        role: 'assistant',
        content: 'all done',
        stopReason: 'end_turn',
      },
    );

    expect(emitConversationEvent).toHaveBeenCalledTimes(1);
    expect(emitConversationEvent).toHaveBeenCalledWith({
      type: 'chat.message',
      event: expect.objectContaining({
        state: 'final',
      }),
    });
  });

  it('chat 事件会保留 sequenceId、requestId、uniqueId 与 agentId', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();

    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'chat',
      {
        runId: 'run-identity-1',
        sessionKey: 'agent:main:main',
        sequenceId: 9,
        requestId: 'user-local-1',
        uniqueId: 'user-local-1',
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
        sequenceId: 9,
        requestId: 'user-local-1',
        uniqueId: 'user-local-1',
        agentId: 'agent-main',
      }),
    });
  });

  it('agent 非生命周期事件只透传 notification，不进入 conversation 通道', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'agent',
      {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        data: {
          state: 'final',
          message: {
            role: 'assistant',
            content: 'hello',
          },
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

  it('agent 生命周期事件会归一化为 run.phase conversation 事件', () => {
    const emitNotification = vi.fn();
    const emitConversationEvent = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitConversationEvent, emitChannelStatus },
      'agent',
      {
        runId: 'run-2',
        sessionKey: 'agent:main:main',
        data: {
          phase: 'started',
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
