import { describe, expect, it, vi } from 'vitest';
import { createOpenClawBridge } from '../../runtime-host/openclaw-bridge';

function createGatewayClientStub() {
  return {
    gatewayRpc: vi.fn(async () => ({ success: true })),
    ensureGatewayReady: vi.fn(async () => undefined),
    isGatewayRunning: vi.fn(async () => true),
    readGatewayConnectionState: vi.fn(async () => ({
      state: 'connected',
      portReachable: true,
      updatedAt: 1,
    })),
    buildSecurityAuditQueryParams: vi.fn(() => ({ page: '1', agentId: 'main' })),
  };
}

describe('runtime-host openclaw bridge', () => {
  it('chat.send 通过 bridge 统一发起并固定 timeout', async () => {
    const client = createGatewayClientStub();
    const bridge = createOpenClawBridge(client);

    await bridge.chatSend({
      sessionKey: 'agent:main:main',
      message: 'hello',
      idempotencyKey: 'user-local-1',
      uniqueId: 'user-local-1',
      requestId: 'user-local-1',
    });

    expect(client.gatewayRpc).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({
        sessionKey: 'agent:main:main',
        message: 'hello',
        idempotencyKey: 'user-local-1',
      }),
      120000,
    );
    expect((client.gatewayRpc.mock.calls[0]?.[1] as { uniqueId?: string }).uniqueId).toBeUndefined();
    expect((client.gatewayRpc.mock.calls[0]?.[1] as { requestId?: string }).requestId).toBeUndefined();
  });

  it('security.audit.query 通过 URL 参数构建器统一映射', async () => {
    const client = createGatewayClientStub();
    const bridge = createOpenClawBridge(client);

    await bridge.securityAuditQueryFromUrl(new URL('http://127.0.0.1/api/security/audit?page=1&agentId=main'));

    expect(client.buildSecurityAuditQueryParams).toHaveBeenCalledTimes(1);
    expect(client.gatewayRpc).toHaveBeenCalledWith(
      'security.audit.query',
      { page: '1', agentId: 'main' },
      8000,
    );
  });

  it('cron.* 链路通过 bridge 收口到固定方法', async () => {
    const client = createGatewayClientStub();
    const bridge = createOpenClawBridge(client);

    await bridge.listCronJobs(true);
    await bridge.updateCronJob('job-1', { enabled: false });
    await bridge.runCronJob('job-1');

    expect(client.gatewayRpc).toHaveBeenNthCalledWith(
      1,
      'cron.list',
      { includeDisabled: true },
    );
    expect(client.gatewayRpc).toHaveBeenNthCalledWith(
      2,
      'cron.update',
      { id: 'job-1', patch: { enabled: false } },
    );
    expect(client.gatewayRpc).toHaveBeenNthCalledWith(
      3,
      'cron.run',
      { id: 'job-1', mode: 'force' },
    );
  });

  it('channels.* 链路通过 bridge 收口到固定方法', async () => {
    const client = createGatewayClientStub();
    const bridge = createOpenClawBridge(client);

    await bridge.channelsStatus(true);
    await bridge.channelsConnect('wecom-main');
    await bridge.channelsDisconnect('wecom-main');
    await bridge.channelsRequestQr('whatsapp');

    expect(client.gatewayRpc).toHaveBeenNthCalledWith(
      1,
      'channels.status',
      { probe: true },
      10000,
    );
    expect(client.gatewayRpc).toHaveBeenNthCalledWith(
      2,
      'channels.connect',
      { channelId: 'wecom-main' },
      10000,
    );
    expect(client.gatewayRpc).toHaveBeenNthCalledWith(
      3,
      'channels.disconnect',
      { channelId: 'wecom-main' },
      10000,
    );
    expect(client.gatewayRpc).toHaveBeenNthCalledWith(
      4,
      'channels.requestQr',
      { type: 'whatsapp' },
      12000,
    );
  });

  it('gateway 运行态查询走统一客户端接口', async () => {
    const client = createGatewayClientStub();
    const bridge = createOpenClawBridge(client);

    await expect(bridge.isGatewayRunning()).resolves.toBe(true);
    expect(client.isGatewayRunning).toHaveBeenCalledTimes(1);
  });

  it('gateway 连接状态查询走统一客户端快照接口', async () => {
    const client = createGatewayClientStub();
    const bridge = createOpenClawBridge(client);

    await expect(bridge.readGatewayConnectionState()).resolves.toEqual({
      state: 'connected',
      portReachable: true,
      updatedAt: 1,
    });
    expect(client.readGatewayConnectionState).toHaveBeenCalledTimes(1);
  });

  it('gateway ready 探测走统一客户端接口', async () => {
    const client = createGatewayClientStub();
    const bridge = createOpenClawBridge(client);

    await expect(bridge.ensureGatewayReady(8000)).resolves.toBeUndefined();
    expect(client.ensureGatewayReady).toHaveBeenCalledWith(8000);
  });
});
