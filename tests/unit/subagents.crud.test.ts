import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubagentsStore } from '@/stores/subagents';

describe('subagents crud', () => {
  beforeEach(() => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockReset();
    useSubagentsStore.setState({
      agents: [{ id: 'main', workspace: '/home/dev/.openclaw/workspace', isDefault: true }],
      availableModels: [{ id: 'gpt-4.1-mini', provider: 'openai' }],
      modelsLoading: false,
      loading: false,
      error: null,
      selectedAgentId: null,
      loadAgents: vi.fn().mockResolvedValue(undefined),
      loadAvailableModels: vi.fn().mockResolvedValue(undefined),
      selectAgent: vi.fn(),
    });
  });

  it('calls agents.create and agents.update with model', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, method) => {
      if (channel === 'gateway:rpc' && method === 'agents.create') {
        return { success: true, result: { agentId: 'writer-v2' } };
      }
      if (channel === 'gateway:rpc' && method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer-v2' }],
          },
        };
      }
      if (channel === 'gateway:rpc' && method === 'agents.update') {
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
    });

    const createdAgentId = await useSubagentsStore.getState().createAgent({
      name: 'writer',
      workspace: '/tmp/writer',
      model: 'gpt-4.1-mini',
    });
    expect(createdAgentId).toBe('writer-v2');

    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.create',
      { name: 'writer', workspace: '/home/dev/.openclaw/workspace-subagents/writer' },
    );
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.update',
      { agentId: 'writer-v2', model: 'gpt-4.1-mini' },
    );
  });

  it('create 在缺少主工作区时，优先用 openclaw:getConfigDir 生成 fallback 工作区', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    useSubagentsStore.setState({
      agents: [{ id: 'main', isDefault: true }],
    });
    invoke.mockImplementation(async (channel, method) => {
      if (channel === 'openclaw:getConfigDir') {
        return 'C:\\Users\\Dev\\.openclaw';
      }
      if (channel === 'gateway:rpc' && method === 'agents.create') {
        return { success: true, result: { agentId: 'writer' } };
      }
      if (channel === 'gateway:rpc' && method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer' }],
          },
        };
      }
      if (channel === 'gateway:rpc' && method === 'agents.update') {
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
    });

    await useSubagentsStore.getState().createAgent({
      name: 'writer',
      workspace: '',
      model: 'gpt-4.1-mini',
    });

    expect(invoke).toHaveBeenCalledWith(
      'openclaw:getConfigDir',
    );
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.create',
      { name: 'writer', workspace: 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\writer' },
    );
  });

  it('passes emoji to agents.create when provided', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, method) => {
      if (channel === 'gateway:rpc' && method === 'agents.create') {
        return { success: true, result: { agentId: 'writer' } };
      }
      if (channel === 'gateway:rpc' && method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer' }],
          },
        };
      }
      if (channel === 'gateway:rpc' && method === 'agents.update') {
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
    });

    await useSubagentsStore.getState().createAgent({
      name: 'writer',
      workspace: '/tmp/writer',
      model: 'gpt-4.1-mini',
      emoji: '🤖',
    });

    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.create',
      { name: 'writer', workspace: '/home/dev/.openclaw/workspace-subagents/writer', emoji: '🤖' },
    );
  });

  it('create 成功后若首次 agents.update 返回 not found，会自动重试并成功', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({ loadAgents });
    let updateCallCount = 0;
    let listCallCount = 0;
    invoke.mockImplementation(async (channel, method) => {
      if (channel === 'gateway:rpc' && method === 'agents.create') {
        return { success: true, result: { agentId: 'test4' } };
      }
      if (channel === 'gateway:rpc' && method === 'agents.list') {
        listCallCount += 1;
        return {
          success: true,
          result: {
            agents: [{ id: 'test4' }],
          },
        };
      }
      if (channel === 'gateway:rpc' && method === 'agents.update') {
        updateCallCount += 1;
        if (updateCallCount === 1) {
          return { success: false, error: 'Error: agent "test4" not found' };
        }
        return { success: true, result: { ok: true } };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
    });

    await expect(useSubagentsStore.getState().createAgent({
      name: 'test4',
      workspace: '/tmp/test4',
      model: 'gpt-4.1-mini',
    })).resolves.toBe('test4');

    expect(updateCallCount).toBe(2);
    expect(listCallCount).toBeGreaterThanOrEqual(2);
    expect(invoke).not.toHaveBeenCalledWith('gateway:rpc', 'secrets.reload', {});
    expect(invoke).not.toHaveBeenCalledWith('gateway:rpc', 'config.patch', expect.anything());
    expect(loadAgents).toHaveBeenCalledTimes(1);
    expect(useSubagentsStore.getState().error).toBeNull();
  });

  it('create 在 agents.create 未返回 agentId 时抛协议错误且不调用 agents.update', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, method) => {
      if (channel === 'gateway:rpc' && method === 'agents.create') {
        return { success: true, result: { ok: true } };
      }
      if (channel === 'gateway:rpc' && method === 'agents.update') {
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
    });

    await expect(useSubagentsStore.getState().createAgent({
      name: 'test-missing-id',
      workspace: '/tmp/test-missing-id',
      model: 'gpt-4.1-mini',
    })).rejects.toThrow('agents.create returned missing agentId');

    expect(invoke).not.toHaveBeenCalledWith('gateway:rpc', 'agents.update', expect.anything());
  });

  it('calls agents.update with model payload', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({ success: true, result: {} });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'writer-v2',
      workspace: '/tmp/writer-v2',
      model: 'gpt-4.1-mini',
    });

    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.update',
      {
        agentId: 'writer',
        name: 'writer-v2',
        workspace: '/tmp/writer-v2',
        model: 'gpt-4.1-mini',
      }
    );
  });

  it('updateAgent 传入 skills allowlist 时应写入 agents.list[].skills', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({
      agents: [
        { id: 'main', workspace: '/home/dev/.openclaw/workspace', isDefault: true },
        {
          id: 'writer',
          name: 'writer-v2',
          workspace: '/tmp/writer-v2',
          model: 'gpt-4.1-mini',
          isDefault: false,
        },
      ],
      loadAgents,
    });

    invoke.mockImplementation(async (channel, method, params) => {
      if (channel !== 'gateway:rpc') {
        throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
      }
      if (method === 'config.get') {
        return {
          success: true,
          result: {
            hash: 'cfg-hash-1',
            config: {
              agents: {
                list: [
                  {
                    id: 'writer',
                    name: 'writer-v2',
                    workspace: '/tmp/writer-v2',
                    model: 'gpt-4.1-mini',
                  },
                ],
              },
            },
          },
        };
      }
      if (method === 'config.set') {
        const payload = params as { raw?: string; baseHash?: string };
        expect(payload.baseHash).toBe('cfg-hash-1');
        expect(typeof payload.raw).toBe('string');
        const parsed = JSON.parse(payload.raw || '{}') as {
          agents?: { list?: Array<{ id?: string; skills?: string[] }> };
        };
        const writer = parsed.agents?.list?.find((entry) => entry.id === 'writer');
        expect(writer?.skills).toEqual(['web-search', 'feishu-doc']);
        return { success: true, result: { ok: true } };
      }
      if (method === 'agents.update') {
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'writer-v2',
      workspace: '/tmp/writer-v2',
      model: 'gpt-4.1-mini',
      skills: ['web-search', 'feishu-doc'],
    });

    expect(invoke).toHaveBeenCalledWith('gateway:rpc', 'config.get', {});
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'config.set',
      expect.objectContaining({
        baseHash: 'cfg-hash-1',
      }),
    );
    expect(loadAgents).toHaveBeenCalledTimes(1);
  });

  it('skips update when payload has no effective changes', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({
      agents: [
        { id: 'main', workspace: '/home/dev/.openclaw/workspace', isDefault: true },
        {
          id: 'writer',
          name: 'writer-v2',
          workspace: '/tmp/writer-v2',
          model: 'gpt-4.1-mini',
          isDefault: false,
        },
      ],
      loadAgents,
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'writer-v2',
      workspace: '/tmp/writer-v2',
      model: 'gpt-4.1-mini',
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(loadAgents).not.toHaveBeenCalled();
  });

  it('calls agents.delete with hard-delete payload', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({ success: true, result: {} });

    await useSubagentsStore.getState().deleteAgent('writer');

    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.delete',
      { agentId: 'writer', deleteFiles: true }
    );
    expect(invoke).not.toHaveBeenCalledWith('subagent:deleteWorkspace', expect.anything());
  });
});
