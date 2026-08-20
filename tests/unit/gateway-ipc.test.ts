import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  },
}));

describe('gateway IPC', () => {
  beforeEach(() => {
    vi.resetModules();
    registeredHandlers.clear();
  });

  it('forwards the Host health projection rather than a peer lifecycle', async () => {
    const outcome = {
      kind: 'succeeded' as const,
      result: { health: { ok: true, lifecycle: 'ready' } },
    };
    const command = vi.fn().mockResolvedValue(outcome);
    const { registerGatewayHandlers } = await import('../../electron/main/ipc/gateway-ipc');

    registerGatewayHandlers({ command });

    const handler = registeredHandlers.get('gateway:status');
    await expect(handler?.({})).resolves.toBe(outcome);
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith({ name: 'host.health' });
  });
});
