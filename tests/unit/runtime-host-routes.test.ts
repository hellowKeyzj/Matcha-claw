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

  it('runtime-host/restart 由主进程执行宿主子进程重启，不承载插件业务 payload', async () => {
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

    const { handleRuntimeHostProcessRoutes } = await import('../../electron/api/routes/runtime-host-process');
    const handled = await handleRuntimeHostProcessRoutes(
      {
        method: 'POST',
      } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/runtime-host/restart'),
      {
        runtimeHost: {
          restart,
          request,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });
});
