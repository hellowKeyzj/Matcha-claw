import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const openPathMock = vi.fn(async () => '');

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    openPath: (...args: unknown[]) => openPathMock(...args),
    showItemInFolder: vi.fn(),
  },
}));

describe('shell ipc', () => {
  beforeEach(() => {
    vi.resetModules();
    registeredHandlers.clear();
    openPathMock.mockReset();
    openPathMock.mockResolvedValue('');
  });

  it('expands tilde paths before delegating shell:openPath', async () => {
    const { registerShellHandlers } = await import('../../electron/main/ipc/shell-ipc');
    registerShellHandlers();

    const openPathHandler = registeredHandlers.get('shell:openPath');
    expect(openPathHandler).toBeTypeOf('function');

    await openPathHandler?.({}, '~/.openclaw/skills');

    expect(openPathMock).toHaveBeenCalledWith(join(homedir(), '.openclaw/skills'));
  });
});
