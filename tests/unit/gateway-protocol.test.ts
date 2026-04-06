import { describe, expect, it, vi } from 'vitest';
import { dispatchGatewayProtocolEvent, isGatewayEventFrame, isGatewayResponseFrame } from '../../runtime-host/openclaw-bridge';

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
  it('agent 事件会发 chat:message 与 notification', () => {
    const emitNotification = vi.fn();
    const emitChatMessage = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitChatMessage, emitChannelStatus },
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

    expect(emitChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          runId: 'run-1',
          sessionKey: 'agent:main:main',
          state: 'final',
        }),
      }),
    );
    expect(emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'agent',
      }),
    );
  });

  it('未知事件只透传 notification', () => {
    const emitNotification = vi.fn();
    const emitChatMessage = vi.fn();
    const emitChannelStatus = vi.fn();
    dispatchGatewayProtocolEvent(
      { emitNotification, emitChatMessage, emitChannelStatus },
      'exec.approval.requested',
      { id: 'approval-1' },
    );

    expect(emitChatMessage).not.toHaveBeenCalled();
    expect(emitChannelStatus).not.toHaveBeenCalled();
    expect(emitNotification).toHaveBeenCalledTimes(1);
    expect(emitNotification).toHaveBeenCalledWith({
      method: 'exec.approval.requested',
      params: { id: 'approval-1' },
    });
  });
});
