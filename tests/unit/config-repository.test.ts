import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigGetResult } from '@/types/subagent';
import {
  patchConfigConsistently,
  readConfigForDisplay,
  readConfigForCommit,
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

  it('patchConfigConsistently 使用已提供的 hash 直接提交', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: { ok: true },
    });

    await patchConfigConsistently(
      { agents: { defaults: { model: null } } },
      {
        baseSnapshot: {
          hash: 'hash-direct',
          config: {},
        } as ConfigGetResult,
      },
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'config.patch',
      {
        raw: JSON.stringify({ agents: { defaults: { model: null } } }),
        baseHash: 'hash-direct',
      },
    );
  });

  it('patchConfigConsistently 在缺少 hash 时先读取 commit 快照', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          hash: 'hash-from-commit',
          config: {},
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: { ok: true },
      });

    await patchConfigConsistently({ agents: { list: [] } }, {
      baseSnapshot: {
        config: {},
      } as ConfigGetResult,
    });

    expect(invoke).toHaveBeenNthCalledWith(1, 'gateway:rpc', 'config.get', {});
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'gateway:rpc',
      'config.patch',
      {
        raw: JSON.stringify({ agents: { list: [] } }),
        baseHash: 'hash-from-commit',
      },
    );
  });

  it('patchConfigConsistently 在 baseHash 冲突时会重读后重试一次', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          hash: 'hash-v1',
          config: {},
        },
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'baseHash mismatch',
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          hash: 'hash-v2',
          config: {},
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: { ok: true },
      });

    await patchConfigConsistently({ agents: { defaults: { model: null } } });

    expect(invoke).toHaveBeenNthCalledWith(1, 'gateway:rpc', 'config.get', {});
    expect(invoke).toHaveBeenNthCalledWith(2, 'gateway:rpc', 'config.patch', {
      raw: JSON.stringify({ agents: { defaults: { model: null } } }),
      baseHash: 'hash-v1',
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'gateway:rpc', 'config.get', {});
    expect(invoke).toHaveBeenNthCalledWith(4, 'gateway:rpc', 'config.patch', {
      raw: JSON.stringify({ agents: { defaults: { model: null } } }),
      baseHash: 'hash-v2',
    });
  });

  it('readConfigForCommit 强制返回带 hash/baseHash 的快照', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: {
        baseHash: 'hash-commit-only',
        config: { agents: { list: [] } },
      },
    });

    const snapshot = await readConfigForCommit();

    expect(snapshot.baseHash).toBe('hash-commit-only');
    expect(invoke).toHaveBeenCalledWith('gateway:rpc', 'config.get', {});
  });
});
