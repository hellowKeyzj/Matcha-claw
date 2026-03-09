import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readConfigForDisplay,
} from '@/lib/openclaw/config-repository';

describe('openclaw config repository', () => {
  beforeEach(() => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockReset();
  });

  it('readConfigForDisplay 优先读取本地快照', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      config: {
        models: {
          providers: {
            openai: {
              models: [{ id: 'gpt-4.1-mini' }],
            },
          },
        },
      },
      path: 'C:/Users/tester/.openclaw/openclaw.json',
    });

    const snapshot = await readConfigForDisplay();

    expect(snapshot?.path).toBe('C:/Users/tester/.openclaw/openclaw.json');
    expect(snapshot?.config.models?.providers?.openai).toBeDefined();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('openclaw:getConfigJson');
  });

  it('readConfigForDisplay 在本地快照不可用时回退 config.get', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({ invalid: true })
      .mockResolvedValueOnce({
        success: true,
        result: {
          hash: 'hash-display-fallback',
          config: {
            agents: { list: [] },
          },
        },
      });

    const snapshot = await readConfigForDisplay();

    expect(snapshot?.hash).toBe('hash-display-fallback');
    expect(invoke).toHaveBeenNthCalledWith(1, 'openclaw:getConfigJson');
    expect(invoke).toHaveBeenNthCalledWith(2, 'gateway:rpc', 'config.get', {});
  });
});
