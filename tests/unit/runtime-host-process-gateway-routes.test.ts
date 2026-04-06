import { describe, expect, it, vi } from 'vitest';
import { handleGatewayRoute } from '../../runtime-host/api/routes/gateway-routes';

function createDeps() {
  return {
    openclawBridge: {
      gatewayRpc: vi.fn(async () => ({ ok: true })),
      chatSend: vi.fn(async () => ({ id: 'msg-1' })),
    },
  };
}

describe('runtime-host process gateway routes', () => {
  it('POST /api/gateway/rpc 通过 openclawBridge.gatewayRpc 转发', async () => {
    const deps = createDeps();

    const result = await handleGatewayRoute(
      'POST',
      '/api/gateway/rpc',
      {
        method: 'chat.history',
        params: { sessionKey: 'agent:main:main' },
        timeoutMs: 9000,
      },
      deps,
    );

    expect(deps.openclawBridge.gatewayRpc).toHaveBeenCalledWith(
      'chat.history',
      { sessionKey: 'agent:main:main' },
      9000,
    );
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        result: { ok: true },
      },
    });
  });

  it('POST /api/gateway/rpc 缺少 method 时返回 400', async () => {
    const deps = createDeps();

    const result = await handleGatewayRoute(
      'POST',
      '/api/gateway/rpc',
      { params: {} },
      deps,
    );

    expect(deps.openclawBridge.gatewayRpc).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 400,
      data: {
        success: false,
        error: 'method is required',
      },
    });
  });

  it('POST /api/gateway/rpc 网关失败时保持 success=false 语义', async () => {
    const deps = createDeps();
    deps.openclawBridge.gatewayRpc.mockRejectedValueOnce(new Error('gateway unavailable'));

    const result = await handleGatewayRoute(
      'POST',
      '/api/gateway/rpc',
      { method: 'chat.send', params: {} },
      deps,
    );

    expect(result).toEqual({
      status: 200,
      data: {
        success: false,
        error: 'Error: gateway unavailable',
      },
    });
  });
});

