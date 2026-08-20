import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayClientRpcMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';

import { useSubagentsStore } from '@/stores/subagents';

const AVATAR_STORAGE_KEY = 'matchaclaw-subagent-avatar-presentations';

describe('subagents crud', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
    vi.mocked(window.electron.ipcRenderer.invoke).mockReset();
    window.localStorage.removeItem(AVATAR_STORAGE_KEY);
    useSubagentsStore.setState({
      agents: [{ id: 'main', workspace: '/home/dev/.openclaw/workspace', isDefault: true }],
      availableModels: [{
        id: 'gpt-4.1-mini',
        provider: 'openai',
        providerLabel: 'OpenAI',
        modelLabel: 'gpt-4.1-mini',
        displayLabel: 'OpenAI / gpt-4.1-mini',
      }],
      modelsLoading: false,
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      error: null,
      selectedAgentId: null,
      loadAgents: vi.fn().mockResolvedValue(undefined),
      loadAvailableModels: vi.fn().mockResolvedValue(undefined),
      selectAgent: vi.fn(),
    });
  });

  it('passes the model to agents.create and writes description once through description.set', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockImplementation(async (method) => {
      if (method === 'agents.create') {
        return { success: true, result: { agentId: 'writer-v2' } };
      }
      if (method === 'description.set') {
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    const createResult = await useSubagentsStore.getState().createAgent({
      name: 'writer',
      description: 'Writes vendor briefs',
      workspace: '/tmp/writer',
      model: 'gpt-4.1-mini',
    });
    expect(createResult).toEqual({ agentId: 'writer-v2' });

    expect(rpc).toHaveBeenCalledWith(
      'agents.create',
      {
        kind: 'create',
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        name: 'writer',
        workspace: '/tmp/writer',
        model: 'gpt-4.1-mini',
      },
      undefined,
    );
    expect(rpc).toHaveBeenCalledWith(
      'description.set',
      {
        kind: 'setDescription',
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        agentId: 'writer-v2',
        description: 'Writes vendor briefs',
      },
      undefined,
    );
    expect(rpc.mock.calls.some(([method]) => method === 'agents.update')).toBe(false);
    expect(rpc.mock.calls.some(([method]) => method === 'config.get')).toBe(false);
    expect(rpc.mock.calls.some(([method]) => method === 'config.patch')).toBe(false);
    expect(rpc.mock.calls.some(([method]) => method === 'config.set')).toBe(false);
    expect(window.localStorage.getItem(AVATAR_STORAGE_KEY)).toBeNull();
  });

  it('create 在缺少显式 workspace 且无法从已有 agent 推导时失败', async () => {
    const rpc = gatewayClientRpcMock;
    useSubagentsStore.setState({
      agents: [{ id: 'main', isDefault: true }],
    });

    await expect(useSubagentsStore.getState().createAgent({
      name: 'writer',
      workspace: '',
      model: 'gpt-4.1-mini',
    })).rejects.toThrow('Subagent workspace is required');

    expect(rpc).not.toHaveBeenCalled();
    expect(vi.mocked(window.electron.ipcRenderer.invoke)).not.toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({ path: '/api/openclaw/config-dir' }),
    );
  });

  it('persists chosen avatar presentation locally when creating agent', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockImplementation(async (method) => {
      if (method === 'agents.create') {
        return { success: true, result: { agentId: 'writer' } };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().createAgent({
      name: 'writer',
      workspace: '/tmp/writer',
      model: 'gpt-4.1-mini',
      avatarSeed: 'picker:writer:page:0:option:3',
      avatarStyle: 'bottts',
    });

    expect(rpc).toHaveBeenCalledWith(
      'agents.create',
      {
        kind: 'create',
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        name: 'writer',
        workspace: '/tmp/writer',
        model: 'gpt-4.1-mini',
      },
      undefined,
    );
    expect(JSON.parse(window.localStorage.getItem(AVATAR_STORAGE_KEY) || '{}')).toEqual({
      writer: {
        avatarSeed: 'picker:writer:page:0:option:3',
        avatarStyle: 'bottts',
      },
    });
  });

  it('does not replay a model mutation after create succeeds', async () => {
    const rpc = gatewayClientRpcMock;
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({ loadAgents });
    rpc.mockImplementation(async (method) => {
      if (method === 'agents.create') {
        return { success: true, result: { agentId: 'test4' } };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await expect(useSubagentsStore.getState().createAgent({
      name: 'test4',
      workspace: '/tmp/test4',
      model: 'gpt-4.1-mini',
    })).resolves.toEqual({ agentId: 'test4' });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith('agents.update', expect.anything(), undefined);
    expect(rpc).not.toHaveBeenCalledWith('secrets.reload', {});
    expect(rpc).not.toHaveBeenCalledWith('config.patch', expect.anything());
    expect(loadAgents).toHaveBeenCalledTimes(1);
    expect(useSubagentsStore.getState().error).toBeNull();
  });

  it('create 在本地头像展示配置写入失败时返回 warning，但不回滚已创建 agent', async () => {
    const rpc = gatewayClientRpcMock;
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({ loadAgents });
    const setItemSpy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('localStorage quota exceeded');
    });
    try {
      rpc.mockImplementation(async (method) => {
        if (method === 'agents.create') {
          return { success: true, result: { agentId: 'writer' } };
        }
        throw new Error(`Unexpected rpc method in test: ${String(method)}`);
      });

      await expect(useSubagentsStore.getState().createAgent({
        name: 'writer',
        workspace: '/tmp/writer',
        model: 'gpt-4.1-mini',
        avatarSeed: 'picker:writer:page:0:option:1',
        avatarStyle: 'botttsNeutral',
        })).resolves.toEqual({
        agentId: 'writer',
        warning: '智能体 "writer" 已创建，但头像展示配置写入失败：localStorage quota exceeded。请在编辑中重新确认',
      });

      expect(loadAgents).toHaveBeenCalledTimes(1);
      expect(useSubagentsStore.getState().error).toBeNull();
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('createAgentFromTemplate uses empty workspace initialization and keeps template files on files.set', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockImplementation(async (method, params) => {
      if (method === 'agents.create') {
        expect(params).toEqual({
          kind: 'create',
          endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
          name: 'Brand Guardian',
          workspace: '/home/dev/.openclaw/workspace-subagents/brand-guardian',
          model: 'gpt-4.1-mini',
        });
        return { success: true, result: { agentId: 'brand-guardian' } };
      }
      if (method === 'agents.files.set') {
        expect(params).toEqual({
          kind: 'filesSet',
          endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
          agentId: 'brand-guardian',
          name: 'AGENTS.md',
          content: 'template agents content',
        });
        expect(params).not.toHaveProperty('workspaceInitialization');
        return { success: true, result: {} };
      }
      if (method === 'agents.files.get') {
        expect(params).not.toHaveProperty('workspaceInitialization');
        return { success: true, result: { file: { content: '' } } };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await expect(useSubagentsStore.getState().createAgentFromTemplate({
      template: {
        id: 'brand-guardian',
        name: 'Brand Guardian',
        files: ['AGENTS.md'],
        fileContents: {
          'AGENTS.md': 'template agents content',
        },
      },
      model: 'gpt-4.1-mini',
    })).resolves.toEqual({ agentId: 'brand-guardian' });

    expect(rpc).not.toHaveBeenCalledWith('config.set', expect.anything(), undefined);
  });

  it('create 在 agents.create 未返回 agentId 时抛协议错误且不调用 agents.update', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockImplementation(async (method) => {
      if (method === 'agents.create') {
        return { success: true, result: { ok: true } };
      }
      if (method === 'agents.update') {
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await expect(useSubagentsStore.getState().createAgent({
      name: 'test-missing-id',
      workspace: '/tmp/test-missing-id',
      model: 'gpt-4.1-mini',
    })).rejects.toThrow('Subagent creation returned an invalid receipt');

    expect(rpc).not.toHaveBeenCalledWith('agents.update', expect.anything());
    expect(rpc).not.toHaveBeenCalledWith('config.get', {}, undefined);
  });

  it('calls agents.update with model payload', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockResolvedValueOnce({ success: true, result: {} });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'writer-v2',
      workspace: '/tmp/writer-v2',
      model: 'gpt-4.1-mini',
    });

    expect(rpc).toHaveBeenCalledWith(
      'agents.update',
      {
        kind: 'update',
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        agentId: 'writer',
        name: 'writer-v2',
        workspace: '/tmp/writer-v2',
        model: 'gpt-4.1-mini',
      },
      undefined,
    );
  });

  it('updateAgent 修改头像时只更新本地展示配置，不写 openclaw config', async () => {
    const rpc = gatewayClientRpcMock;
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({
      agents: [
        { id: 'main', workspace: '/home/dev/.openclaw/workspace', isDefault: true },
        {
          id: 'writer',
          name: 'writer-v2',
          workspace: '/tmp/writer-v2',
          model: 'gpt-4.1-mini',
          avatarSeed: 'agent:writer',
          avatarStyle: 'pixelArt',
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
      avatarSeed: 'picker:writer:page:1:option:2',
      avatarStyle: 'bottts',
    });

    expect(rpc).not.toHaveBeenCalledWith('config.get', {}, undefined);
    expect(rpc).not.toHaveBeenCalledWith('config.set', expect.anything(), undefined);
    expect(JSON.parse(window.localStorage.getItem(AVATAR_STORAGE_KEY) || '{}')).toEqual({
      writer: {
        avatarSeed: 'picker:writer:page:1:option:2',
        avatarStyle: 'bottts',
      },
    });
    expect(loadAgents).toHaveBeenCalledTimes(1);
  });

  it('updateAgent 选择默认模型时会通过 model.set 清理 agent model', async () => {
    const rpc = gatewayClientRpcMock;
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

    rpc.mockImplementation(async (method) => {
      if (method === 'model.set') {
        return { success: true, result: { revision: 'cfg-revision-model-reset', updatedAt: Date.now(), config: {} } };
      }
      if (method === 'agents.update') {
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'writer-v2',
      workspace: '/tmp/writer-v2',
      model: undefined,
    });

    expect(rpc).toHaveBeenCalledWith('model.set', {
      kind: 'setConfigurationModel',
      endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      agentId: 'writer',
      model: null,
    }, undefined);
    expect(rpc.mock.calls.some(([method]) => method === 'config.get')).toBe(false);
    expect(rpc.mock.calls.some(([method]) => method === 'config.set')).toBe(false);
    const updateCalls = rpc.mock.calls.filter(([method]) => method === 'agents.update');
    expect(updateCalls).toHaveLength(0);
    expect(loadAgents).toHaveBeenCalledTimes(1);
  });

  it('updateAgent 传入 skills allowlist 时应通过 skills.set 写入', async () => {
    const rpc = gatewayClientRpcMock;
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

    rpc.mockImplementation(async (method) => {
      if (method === 'skills.set') {
        return { success: true, result: { revision: 'cfg-revision-skills', updatedAt: Date.now(), config: {} } };
      }
      if (method === 'agents.update') {
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'writer-v2',
      workspace: '/tmp/writer-v2',
      model: 'gpt-4.1-mini',
      skills: ['web-search', 'feishu-doc'],
    });

    expect(rpc).toHaveBeenCalledWith(
      'skills.set',
      {
        kind: 'setSkills',
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        agentId: 'writer',
        skills: ['web-search', 'feishu-doc'],
      },
      undefined,
    );
    expect(rpc.mock.calls.some(([method]) => method === 'config.get')).toBe(false);
    expect(rpc.mock.calls.some(([method]) => method === 'config.set')).toBe(false);
    expect(loadAgents).toHaveBeenCalledTimes(1);
  });

  it('skips update when payload has no effective changes', async () => {
    const rpc = gatewayClientRpcMock;
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

    expect(rpc).not.toHaveBeenCalled();
    expect(loadAgents).not.toHaveBeenCalled();
  });

  it('calls agents.delete with hard-delete payload', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockResolvedValueOnce({ success: true, result: {} });

    await useSubagentsStore.getState().deleteAgent('writer');

    expect(rpc).toHaveBeenCalledWith(
      'agents.delete',
      { kind: 'delete', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'writer', deleteFiles: true }
      ,
      undefined
    );
    expect(rpc).not.toHaveBeenCalledWith('subagent:deleteWorkspace', expect.anything());
  });
});
