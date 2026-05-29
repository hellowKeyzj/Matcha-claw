import { homedir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const openPathMock = vi.fn(async () => '');

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
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

  it('opens resource-relative paths from the bundled resources directory', async () => {
    const { registerShellHandlers } = await import('../../electron/main/ipc/shell-ipc');
    registerShellHandlers();

    const openResourcePathHandler = registeredHandlers.get('shell:openResourcePath');
    expect(openResourcePathHandler).toBeTypeOf('function');

    const result = await openResourcePathHandler?.({}, 'connector-guide/wechat.html');

    const expectedPath = normalize(resolve(process.cwd(), 'resources', 'connector-guide', 'wechat.html')).toLowerCase();
    expect(normalize(String(openPathMock.mock.calls[0]?.[0])).toLowerCase()).toBe(expectedPath);
    expect(result).toMatchObject({ success: true });
    expect(normalize(String((result as { resolvedPath?: string }).resolvedPath)).toLowerCase()).toBe(expectedPath);
  });

  it('rejects resource paths that escape the resources directory', async () => {
    const { registerShellHandlers } = await import('../../electron/main/ipc/shell-ipc');
    registerShellHandlers();

    const openResourcePathHandler = registeredHandlers.get('shell:openResourcePath');
    const result = await openResourcePathHandler?.({}, '../package.json');

    expect(openPathMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'resource_path_outside_resources',
      rawPath: '../package.json',
    });
  });
});
