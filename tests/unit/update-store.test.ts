import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUpdateStore } from '@/stores/update';

describe('Update Store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(window.electron.ipcRenderer.invoke).mockReset();
    vi.mocked(window.electron.ipcRenderer.on).mockReset();
    useUpdateStore.setState({
      status: 'idle',
      currentVersion: '0.0.0',
      updateInfo: null,
      progress: null,
      error: null,
      isInitialized: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not keep an older available version as an installable update', async () => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockImplementation(async (channel: string) => {
      if (channel === 'update:version') {
        return '1.0.1';
      }
      if (channel === 'update:status') {
        return {
          status: 'available',
          info: { version: '1.0.0' },
        };
      }
      return undefined;
    });

    await useUpdateStore.getState().init();

    expect(useUpdateStore.getState().status).toBe('not-available');
    expect(useUpdateStore.getState().updateInfo).toBeNull();
  });
});
