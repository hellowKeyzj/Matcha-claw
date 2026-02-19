import { describe, expect, it, vi } from 'vitest';
import { useSubagentsStore } from '@/stores/subagents';

describe('subagents default agent', () => {
  it('always keeps main as default in page state', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main' },
            { id: 'writer', name: 'Writer' },
          ],
          defaultId: 'writer',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          hash: 'hash-default',
          config: {
            agents: {
              list: [
                { id: 'main', name: 'Main', default: false },
                { id: 'writer', name: 'Writer', default: true },
              ],
            },
          },
        },
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toEqual([
      {
        id: 'main',
        name: 'Main',
        workspace: undefined,
        model: undefined,
        isDefault: true,
      },
      {
        id: 'writer',
        name: 'Writer',
        workspace: undefined,
        model: undefined,
        isDefault: false,
      },
    ]);
  });
});
