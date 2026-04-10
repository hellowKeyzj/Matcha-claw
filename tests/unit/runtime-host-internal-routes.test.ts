import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

describe('runtime-host internal routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('token 错误时返回 403', async () => {
    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'POST',
        headers: {
          'x-runtime-host-dispatch-token': 'bad-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/execution-sync'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'good-token',
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 403, expect.objectContaining({
      success: false,
      status: 403,
      error: expect.objectContaining({ code: 'FORBIDDEN' }),
    }));
  });

  it('execution-sync 路由会调用 runtimeHost 执行态写入并返回最新 execution', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      version: 1,
      action: 'set_execution_enabled',
      payload: { enabled: false },
    });
    const setExecutionEnabled = vi.fn(async () => ({
      pluginExecutionEnabled: false,
      enabledPluginIds: ['security-core'],
    }));
    const setEnabledPluginIds = vi.fn(async () => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['security-core'],
    }));
    const restart = vi.fn(async () => {});

    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'POST',
        headers: {
          'x-runtime-host-dispatch-token': 'test-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/execution-sync'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'test-token',
          setExecutionEnabled,
          setEnabledPluginIds,
          restart,
          getExecutionState: () => ({
            pluginExecutionEnabled: false,
            enabledPluginIds: ['security-core'],
          }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(setExecutionEnabled).toHaveBeenCalledWith(false);
    expect(setEnabledPluginIds).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      version: 1,
      success: true,
      status: 200,
      data: {
        execution: {
          pluginExecutionEnabled: false,
          enabledPluginIds: ['security-core'],
        },
      },
    });
  });

  it('shell-actions 路由会调用 runtimeHost.executeShellAction 并透传结果', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      version: 1,
      action: 'provider_oauth_start',
      payload: {
        provider: 'openai',
        accountId: 'acc-1',
      },
    });
    const executeShellAction = vi.fn(async () => ({
      status: 200,
      data: { success: true },
    }));

    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'POST',
        headers: {
          'x-runtime-host-dispatch-token': 'test-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/shell-actions'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'test-token',
          executeShellAction,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(executeShellAction).toHaveBeenCalledWith('provider_oauth_start', {
      provider: 'openai',
      accountId: 'acc-1',
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      version: 1,
      success: true,
      status: 200,
      data: { success: true },
    });
  });

  it('shell-actions 支持 shell_open_path 动作透传', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      version: 1,
      action: 'shell_open_path',
      payload: {
        path: 'C:\\Users\\Mr.Key\\.openclaw\\skills\\docx',
      },
    });
    const executeShellAction = vi.fn(async () => ({
      status: 200,
      data: { success: true },
    }));

    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'POST',
        headers: {
          'x-runtime-host-dispatch-token': 'test-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/shell-actions'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'test-token',
          executeShellAction,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(executeShellAction).toHaveBeenCalledWith('shell_open_path', {
      path: 'C:\\Users\\Mr.Key\\.openclaw\\skills\\docx',
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      version: 1,
      success: true,
      status: 200,
      data: { success: true },
    });
  });

  it('gateway-events 路由会调用 runtimeHost.emitGatewayEvent', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      version: 1,
      eventName: 'gateway:notification',
      payload: {
        method: 'agent',
        params: { runId: 'run-1' },
      },
    });
    const emitGatewayEvent = vi.fn();

    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'POST',
        headers: {
          'x-runtime-host-dispatch-token': 'test-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/gateway-events'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'test-token',
          emitGatewayEvent,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(emitGatewayEvent).toHaveBeenCalledWith('gateway:notification', {
      method: 'agent',
      params: { runId: 'run-1' },
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      version: 1,
      success: true,
      status: 200,
      data: { accepted: true },
    });
  });

  it('gateway-events 支持 gateway:connection 事件透传', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      version: 1,
      eventName: 'gateway:connection',
      payload: {
        state: 'reconnecting',
        reason: 'connect timeout',
      },
    });
    const emitGatewayEvent = vi.fn();

    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'POST',
        headers: {
          'x-runtime-host-dispatch-token': 'test-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/gateway-events'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'test-token',
          emitGatewayEvent,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(emitGatewayEvent).toHaveBeenCalledWith('gateway:connection', {
      state: 'reconnecting',
      reason: 'connect timeout',
    });
  });

  it('execution-sync set_enabled_plugin_ids 会调用 setEnabledPluginIds', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      version: 1,
      action: 'set_enabled_plugin_ids',
      payload: { pluginIds: ['task-manager'] },
    });
    const setExecutionEnabled = vi.fn(async () => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['security-core'],
    }));
    const setEnabledPluginIds = vi.fn(async () => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['task-manager'],
    }));
    const restart = vi.fn(async () => {});

    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'POST',
        headers: {
          'x-runtime-host-dispatch-token': 'test-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/execution-sync'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'test-token',
          setExecutionEnabled,
          setEnabledPluginIds,
          restart,
          getExecutionState: () => ({
            pluginExecutionEnabled: true,
            enabledPluginIds: ['task-manager'],
          }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(setExecutionEnabled).not.toHaveBeenCalled();
    expect(setEnabledPluginIds).toHaveBeenCalledWith(['task-manager']);
    expect(restart).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      version: 1,
      success: true,
      status: 200,
      data: {
        execution: {
          pluginExecutionEnabled: true,
          enabledPluginIds: ['task-manager'],
        },
      },
    });
  });

  it('execution-sync restart_runtime_host 会调用 restart', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      version: 1,
      action: 'restart_runtime_host',
    });
    const setExecutionEnabled = vi.fn(async () => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['security-core'],
    }));
    const setEnabledPluginIds = vi.fn(async () => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['security-core'],
    }));
    const restart = vi.fn(async () => {});

    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'POST',
        headers: {
          'x-runtime-host-dispatch-token': 'test-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/execution-sync'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'test-token',
          setExecutionEnabled,
          setEnabledPluginIds,
          restart,
          getExecutionState: () => ({
            pluginExecutionEnabled: true,
            enabledPluginIds: ['security-core'],
          }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(setExecutionEnabled).not.toHaveBeenCalled();
    expect(setEnabledPluginIds).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      version: 1,
      success: true,
      status: 200,
      data: {
        execution: {
          pluginExecutionEnabled: true,
          enabledPluginIds: ['security-core'],
        },
      },
    });
  });

  it('非 POST 方法会返回统一 transport 错误体', async () => {
    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'GET',
        headers: {
          'x-runtime-host-dispatch-token': 'test-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/execution-sync'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'test-token',
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 405, expect.objectContaining({
      version: 1,
      success: false,
      status: 405,
      error: expect.objectContaining({
        code: 'BAD_REQUEST',
      }),
    }));
  });

  it('execution-sync body 非对象时返回 BAD_REQUEST', async () => {
    parseJsonBodyMock.mockResolvedValueOnce('invalid-body');
    const setExecutionEnabled = vi.fn(async () => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['security-core'],
    }));
    const setEnabledPluginIds = vi.fn(async () => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['security-core'],
    }));
    const restart = vi.fn(async () => {});

    const { handleRuntimeHostInternalRoutes } = await import('../../electron/api/routes/runtime-host-internal');
    const handled = await handleRuntimeHostInternalRoutes(
      {
        method: 'POST',
        headers: {
          'x-runtime-host-dispatch-token': 'test-token',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/internal/runtime-host/execution-sync'),
      {
        runtimeHost: {
          getInternalDispatchToken: () => 'test-token',
          setExecutionEnabled,
          setEnabledPluginIds,
          restart,
          getExecutionState: () => ({
            pluginExecutionEnabled: true,
            enabledPluginIds: ['security-core'],
          }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(setExecutionEnabled).not.toHaveBeenCalled();
    expect(setEnabledPluginIds).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, expect.objectContaining({
      version: 1,
      success: false,
      status: 400,
      error: expect.objectContaining({
        code: 'BAD_REQUEST',
      }),
    }));
  });
});
