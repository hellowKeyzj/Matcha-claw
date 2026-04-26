import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const sendJsonMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

describe('runtime-host main routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('plugins/runtime/restart 由主进程重启 runtime-host，再读取最新 runtime payload 返回', async () => {
    const restart = vi.fn(async () => {});
    const request = vi.fn(async () => ({
      status: 200,
      data: {
        success: true,
        state: {
          lifecycle: 'running',
          runtimeLifecycle: 'running',
          activePluginCount: 1,
          enabledPluginIds: ['security-core'],
        },
        health: {
          ok: true,
          lifecycle: 'running',
          activePluginCount: 1,
          degradedPlugins: [],
        },
        execution: {
          enabledPluginIds: ['security-core'],
        },
      },
    }));

    const { handleRuntimeHostRoutes } = await import('../../electron/api/routes/runtime-host');
    const handled = await handleRuntimeHostRoutes(
      {
        method: 'POST',
      } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/plugins/runtime/restart'),
      {
        runtimeHost: {
          restart,
          request,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('GET', '/api/plugins/runtime');
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      execution: {
        enabledPluginIds: ['security-core'],
      },
    }));
  });
});
