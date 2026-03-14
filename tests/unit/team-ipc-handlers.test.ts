import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMock = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
  },
}));

describe('team ipc handlers', () => {
  beforeEach(() => {
    vi.resetModules();
    handleMock.mockReset();
  });

  it('loads module and registers all team channels', async () => {
    const mod = await import('@electron/main/team-ipc-handlers');
    expect(() => mod.registerTeamIpcHandlers()).not.toThrow();

    const channels = handleMock.mock.calls.map(([channel]) => channel);
    expect(channels).toEqual([
      'team:init',
      'team:snapshot',
      'team:planUpsert',
      'team:claimNext',
      'team:heartbeat',
      'team:taskUpdate',
      'team:mailboxPost',
      'team:mailboxPull',
      'team:releaseClaim',
      'team:reset',
      'team:listTasks',
    ]);
  });
});
