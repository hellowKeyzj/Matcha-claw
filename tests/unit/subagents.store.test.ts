import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capabilityExecuteMock,
  gatewayClientRpcMock,
  hostApiFetchMock,
  resetGatewayClientMocks,
} from './helpers/mock-gateway-client';

import i18n from '@/i18n';
import { getCall } from '@/lib/call-log';
import * as hostApiModule from '@/lib/host-api';
import {
  __resetSubagentsStoreInternalCachesForTest,
  useSubagentsStore,
} from '@/stores/subagents';

const AVATAR_STORAGE_KEY = 'matchaclaw-subagent-avatar-presentations';
const runtimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};
function displayConfigResult(input: {
  agents?: unknown[];
  defaults?: unknown;
  revision?: string;
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
} = {}) {
  return {
    agents: input.agents ?? [],
    defaults: input.defaults ?? {},
    revision: input.revision ?? 'test-revision',
    ready: input.ready ?? true,
    refreshing: input.refreshing ?? false,
    updatedAt: input.updatedAt === undefined ? 0 : input.updatedAt,
    error: input.error ?? null,
  };
}

async function waitForExpect(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (lastError) {
    throw lastError;
  }
  assertion();
}

describe('subagents store', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
    __resetSubagentsStoreInternalCachesForTest();
    window.localStorage.removeItem(AVATAR_STORAGE_KEY);
    useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
  });

  it('loads agents.list through fixed agents delivery', async () => {
    gatewayClientRpcMock.mockResolvedValueOnce({
      success: true,
      result: {
        agents: [{ id: 'main' }],
        defaultId: 'main',
        mainKey: 'main',
        scope: 'per-sender',
      },
    });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents.length).toBe(1);
    expect(gatewayClientRpcMock).toHaveBeenCalledWith(
      'agents.list',
      { kind: 'list', endpoint: runtimeEndpoint },
      undefined,
    );
    expect(gatewayClientRpcMock).toHaveBeenCalledWith(
      'agents.list',
      { kind: 'list', endpoint: runtimeEndpoint },
      undefined,
    );
    expect(capabilityExecuteMock).not.toHaveBeenCalled();
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/subagents/list', expect.anything());
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/subagents/config/get', expect.anything());
  });

  it('首次 loadAgents 失败后也应收口 not-ready，避免侧栏永久停在 Loading', async () => {
    gatewayClientRpcMock.mockRejectedValueOnce(new Error('agents list failed'));

    await useSubagentsStore.getState().loadAgents();

    const state = useSubagentsStore.getState();
    expect(state.agentsResource.status).toBe('error');
    expect(state.agentsResource.hasLoadedOnce).toBe(false);
    expect(state.agentsResource.error).toBe('agents list failed');
    expect(state.error).toBe('agents list failed');
    expect(state.agents).toEqual([]);
  });

  it('首次 agents.list 明确 not-ready 且带错误时进入 error，不无限 loading', async () => {
    gatewayClientRpcMock.mockResolvedValueOnce({
      success: true,
      result: {
        agents: [],
        defaultId: 'main',
        ready: false,
        refreshing: false,
        updatedAt: null,
        error: 'Subagent management is unavailable',
      },
    });

    await useSubagentsStore.getState().loadAgents();

    const state = useSubagentsStore.getState();
    expect(state.agentsResource.status).toBe('error');
    expect(state.agentsResource.hasLoadedOnce).toBe(false);
    expect(state.agentsResource.error).toBe('Subagent management is unavailable');
    expect(state.error).toBe('Subagent management is unavailable');
    expect(state.agents).toEqual([]);
  });

  it('已有旧列表时 agents.list not-ready 保留 ready 数据并静默重试', async () => {
    useSubagentsStore.setState({
      agents: [{ id: 'main', name: 'Main', isDefault: true }],
      agentsResource: {
        data: [{ id: 'main', name: 'Main', isDefault: true }],
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
    });
    gatewayClientRpcMock.mockResolvedValueOnce({
      success: true,
      result: {
        agents: [],
        defaultId: 'main',
        ready: false,
        refreshing: true,
        updatedAt: null,
        error: 'Subagent management is unavailable',
      },
    });

    await useSubagentsStore.getState().loadAgents({ silent: true });

    const state = useSubagentsStore.getState();
    expect(state.agentsResource.status).toBe('ready');
    expect(state.agentsResource.hasLoadedOnce).toBe(true);
    expect(state.agentsResource.error).toBeNull();
    expect(state.error).toBe('Subagent management is unavailable');
    expect(state.agents).toEqual([{ id: 'main', name: 'Main', isDefault: true }]);
  });

  it('loadAgents 与 loadAvailableModels 并发时，只有 loadAgents 会读取 displayConfig.get', async () => {
    const rpc = gatewayClientRpcMock;
    let resolveDisplayConfigGet!: (value: unknown) => void;
    const displayConfigGetTask = new Promise((resolve) => {
      resolveDisplayConfigGet = resolve;
    });
    hostApiFetchMock.mockResolvedValue({ models: [] });
    rpc.mockImplementation(async (method) => {
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'main', name: 'Main', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' }],
            defaultId: 'main',
          },
        };
      }
      if (method === 'displayConfig.get') {
        return displayConfigGetTask as Promise<unknown>;
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    const loadAgentsTask = useSubagentsStore.getState().loadAgents();
    const loadModelsTask = useSubagentsStore.getState().loadAvailableModels();
    resolveDisplayConfigGet({
      success: true,
      result: displayConfigResult({
        agents: [{ id: 'main', model: 'openai/gpt-4.1-mini' }],
      }),
    });

    await Promise.all([loadAgentsTask, loadModelsTask]);

    const displayConfigGetCalls = rpc.mock.calls.filter(
      ([method]) => method === 'displayConfig.get'
    );
    expect(displayConfigGetCalls).toHaveLength(1);
    expect(rpc).not.toHaveBeenCalledWith('models.list', {}, undefined);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/provider-models/selectable?capability=chat', undefined);
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/provider-accounts', undefined);
  });

  it('短 TTL 内重复 loadAgents 复用 displayConfig.get 结果', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockImplementation(async (method) => {
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'main', name: 'Main', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' }],
            defaultId: 'main',
          },
        };
      }
      if (method === 'displayConfig.get') {
        return {
          success: true,
          result: displayConfigResult({
            agents: [{ id: 'main', workspace: '/workspace/main' }],
          }),
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().loadAgents();
    await useSubagentsStore.getState().loadAgents();

    const displayConfigGetCalls = rpc.mock.calls.filter(
      ([method]) => method === 'displayConfig.get'
    );
    expect(displayConfigGetCalls).toHaveLength(1);
  });

  it('loadAgents 使用 defaults.skills 作为未显式配置 agent 的展示默认值', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', skills: ['runtime-shell'] },
            { id: 'writer', name: 'Writer' },
            { id: 'locked', name: 'Locked', skills: ['runtime-locked'] },
          ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          defaults: {
            skills: ['web-search', 'repo-read'],
          },
          agents: [
            { id: 'main', skills: ['shell'] },
            { id: 'writer' },
            { id: 'locked', skills: [] },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    const skillsByAgentId = new Map(
      useSubagentsStore.getState().agents.map((agent) => [agent.id, agent.skills]),
    );
    expect(skillsByAgentId.get('main')).toEqual(['shell']);
    expect(skillsByAgentId.get('writer')).toEqual(['web-search', 'repo-read']);
    expect(skillsByAgentId.get('locked')).toEqual([]);
  });

  it('updateAgent 会把 skill 请求写成显式 allowlist，即使当前有效 skills 看起来未变化', async () => {
    const rpc = gatewayClientRpcMock;
    let skillsSetParams: Record<string, unknown> | undefined;

    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          workspace: '/workspace/writer',
          skills: ['web-search'],
          isDefault: true,
        },
      ],
      selectedAgentId: 'writer',
    });

    rpc.mockImplementation(async (method, params) => {
      if (method === 'skills.set') {
        skillsSetParams = params as Record<string, unknown>;
        return { success: true, result: {} };
      }
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer', name: 'Writer' }],
            defaultId: 'writer',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      if (method === 'displayConfig.get') {
        return {
          success: true,
          result: displayConfigResult({
            defaults: { skills: ['web-search'] },
            agents: [{ id: 'writer', workspace: '/workspace/writer', skills: ['web-search'] }],
          }),
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'Writer',
      workspace: '/workspace/writer',
      skills: ['web-search'],
    });

    expect(skillsSetParams).toEqual({ kind: 'setSkills', endpoint: runtimeEndpoint, agentId: 'writer', skills: ['web-search'] });
  });

  it('updateAgent 没有 skills 字段的普通更新不调用 skills.set', async () => {
    const rpc = gatewayClientRpcMock;

    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          workspace: '/workspace/writer',
          model: 'openai/gpt-4.1-mini',
          skills: ['web-search'],
          isDefault: true,
        },
      ],
      selectedAgentId: 'writer',
    });

    rpc.mockImplementation(async (method, params) => {
      if (method === 'agents.update') {
        expect(params).toEqual({
          kind: 'update',
          endpoint: runtimeEndpoint,
          agentId: 'writer',
          name: 'Writer Renamed',
          workspace: '/workspace/writer',
        });
        return { success: true, result: {} };
      }
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer', name: 'Writer Renamed' }],
            defaultId: 'writer',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      if (method === 'displayConfig.get') {
        return {
          success: true,
          result: displayConfigResult({
            agents: [{ id: 'writer', workspace: '/workspace/writer', skills: ['web-search'] }],
          }),
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'Writer Renamed',
      workspace: '/workspace/writer',
      model: 'openai/gpt-4.1-mini',
    });

    expect(rpc.mock.calls.some(([method]) => method === 'skills.set')).toBe(false);
  });

  it('updateAgent 写入 description 时通过 description.set 局部更新，不透传给 agents.update', async () => {
    const rpc = gatewayClientRpcMock;
    let descriptionSetParams: Record<string, unknown> | undefined;

    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          description: 'Old description',
          workspace: '/workspace/writer',
          model: 'openai/gpt-4.1-mini',
          isDefault: true,
        },
      ],
      selectedAgentId: 'writer',
    });

    rpc.mockImplementation(async (method, params) => {
      if (method === 'description.set') {
        descriptionSetParams = params as Record<string, unknown>;
        return { success: true, result: {} };
      }
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer', name: 'Writer' }],
            defaultId: 'writer',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      if (method === 'displayConfig.get') {
        return {
          success: true,
          result: displayConfigResult({
            agents: [
              { id: 'writer', description: 'New description', workspace: '/workspace/writer' },
              { id: 'reviewer', skills: ['unknown-skill'] },
            ],
          }),
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'Writer',
      description: 'New description',
      workspace: '/workspace/writer',
      model: 'openai/gpt-4.1-mini',
    });

    expect(descriptionSetParams).toEqual({
      kind: 'setDescription',
      endpoint: runtimeEndpoint,
      agentId: 'writer',
      description: 'New description',
    });
    expect(rpc.mock.calls.some(([method]) => method === 'agents.update')).toBe(false);
  });

  it('updateAgent 清空 description 时通过 description.set 明确写入 null', async () => {
    const rpc = gatewayClientRpcMock;
    let descriptionSetParams: Record<string, unknown> | undefined;

    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          description: 'Old description',
          workspace: '/workspace/writer',
          model: 'openai/gpt-4.1-mini',
          isDefault: true,
        },
      ],
      selectedAgentId: 'writer',
    });

    rpc.mockImplementation(async (method, params) => {
      if (method === 'description.set') {
        descriptionSetParams = params as Record<string, unknown>;
        return { success: true, result: {} };
      }
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer', name: 'Writer' }],
            defaultId: 'writer',
          },
        };
      }
      if (method === 'displayConfig.get') {
        return {
          success: true,
          result: displayConfigResult({
            agents: [{ id: 'writer' }],
          }),
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'Writer',
      description: '',
      workspace: '/workspace/writer',
      model: 'openai/gpt-4.1-mini',
    });

    expect(descriptionSetParams).toEqual({
      kind: 'setDescription',
      endpoint: runtimeEndpoint,
      agentId: 'writer',
      description: null,
    });
    expect(rpc.mock.calls.some(([method]) => method === 'agents.update')).toBe(false);
  });

  it('updateAgent 清空 model 时通过 agents.update 明确写入 null', async () => {
    const rpc = gatewayClientRpcMock;
    let agentsUpdateParams: Record<string, unknown> | undefined;

    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          workspace: '/workspace/writer',
          model: 'openai/gpt-4.1-mini',
          isDefault: true,
        },
      ],
      selectedAgentId: 'writer',
    });

    rpc.mockImplementation(async (method, params) => {
      if (method === 'agents.update') {
        agentsUpdateParams = params as Record<string, unknown>;
        return { success: true, result: {} };
      }
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer', name: 'Writer' }],
            defaultId: 'writer',
          },
        };
      }
      if (method === 'displayConfig.get') {
        return {
          success: true,
          result: displayConfigResult({
            agents: [{ id: 'writer' }],
          }),
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'Writer',
      workspace: '/workspace/writer',
      model: '',
    });

    expect(agentsUpdateParams).toEqual({
      kind: 'update',
      endpoint: runtimeEndpoint,
      agentId: 'writer',
      model: null,
    });
    expect(rpc.mock.calls.some(([method]) => method === 'model.set')).toBe(false);
  });

  it('updateAgent 清空 skills 时通过 skills.set 明确写入空 allowlist', async () => {
    const rpc = gatewayClientRpcMock;
    let skillsSetParams: Record<string, unknown> | undefined;

    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          workspace: '/workspace/writer',
          skills: ['web-search'],
          isDefault: true,
        },
      ],
      selectedAgentId: 'writer',
    });

    rpc.mockImplementation(async (method, params) => {
      if (method === 'skills.set') {
        skillsSetParams = params as Record<string, unknown>;
        return { success: true, result: {} };
      }
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer', name: 'Writer' }],
            defaultId: 'writer',
          },
        };
      }
      if (method === 'displayConfig.get') {
        return {
          success: true,
          result: displayConfigResult({
            agents: [{ id: 'writer' }],
          }),
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'Writer',
      workspace: '/workspace/writer',
      skills: null,
    });

    expect(skillsSetParams).toEqual({
      kind: 'setSkills',
      endpoint: runtimeEndpoint,
      agentId: 'writer',
      skills: [],
    });
  });

  it('updateAgent skill allowlist 写入失败时会 reject 并保留错误状态', async () => {
    const rpc = gatewayClientRpcMock;

    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          workspace: '/workspace/writer',
          skills: ['web-search'],
          isDefault: true,
        },
      ],
      selectedAgentId: 'writer',
    });

    rpc.mockImplementation(async (method) => {
      if (method === 'skills.set') {
        throw new Error('skill config write failed');
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await expect(useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'Writer',
      workspace: '/workspace/writer',
      skills: [],
    })).rejects.toThrow('skill config write failed');

    expect(useSubagentsStore.getState().error).toBe('skill config write failed');
  });

  it('updateAgent 写入 skills 后忽略旧 in-flight displayConfig.get，并通过刷新显示新 skills', async () => {
    const rpc = gatewayClientRpcMock;
    let resolveStaleDisplayConfig!: (value: unknown) => void;
    const staleDisplayConfigTask = new Promise((resolve) => {
      resolveStaleDisplayConfig = resolve;
    });
    let displayConfigGetCallCount = 0;
    let skillsSetParams: Record<string, unknown> | undefined;
    let refreshConfigReadOccurred = false;

    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          workspace: '/workspace/writer',
          skills: [],
          isDefault: true,
        },
      ],
      selectedAgentId: 'writer',
    });

    rpc.mockImplementation(async (method, params) => {
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer', name: 'Writer' }],
            defaultId: 'writer',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      if (method === 'displayConfig.get') {
        displayConfigGetCallCount += 1;
        if (displayConfigGetCallCount === 1) {
          return staleDisplayConfigTask as Promise<unknown>;
        }
        refreshConfigReadOccurred = true;
        return {
          success: true,
          result: displayConfigResult({
            agents: [
              { id: 'writer', workspace: '/workspace/writer', skills: ['web-search'] },
            ],
          }),
        };
      }
      if (method === 'skills.set') {
        skillsSetParams = params as Record<string, unknown>;
        return { success: true, result: {} };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    const initialLoadTask = useSubagentsStore.getState().loadAgents();
    await waitForExpect(() => {
      expect(displayConfigGetCallCount).toBe(1);
    });

    const updateTask = useSubagentsStore.getState().updateAgent({
      agentId: 'writer',
      name: 'Writer',
      workspace: '/workspace/writer',
      skills: ['web-search'],
    });
    await waitForExpect(() => {
      expect(skillsSetParams).toEqual({ kind: 'setSkills', endpoint: runtimeEndpoint, agentId: 'writer', skills: ['web-search'] });
    });

    resolveStaleDisplayConfig({
      success: true,
      result: displayConfigResult({
        revision: 'stale-display-revision',
        agents: [
          { id: 'writer', workspace: '/workspace/writer', skills: [] },
        ],
      }),
    });

    await Promise.all([initialLoadTask, updateTask]);

    const writer = useSubagentsStore.getState().agents.find((agent) => agent.id === 'writer');
    expect(refreshConfigReadOccurred).toBe(true);
    expect(writer?.skills).toEqual(['web-search']);
  });

  it('loadAgents 仅从 runtime agents.list 获取 workspace，并从安全 displayConfig 获取 description/model', async () => {
    const rpc = gatewayClientRpcMock;
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main-old',
          workspace: '~/.openclaw/workspace-main',
          model: 'openai/gpt-5',
        },
        {
          id: 'writer',
          name: 'Writer-old',
          workspace: '~/.openclaw/workspace-subagents/writer',
          model: 'openai/gpt-4.1-mini',
        },
      ],
    });
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
            agents: [
              {
                id: 'main',
                name: 'Main',
                workspace: '~/.openclaw/workspace-main-runtime',
                avatarSeed: 'agent:main',
                avatarStyle: 'pixelArt',
              },
              {
                id: 'writer',
                name: 'Writer',
                workspace: '~/.openclaw/workspace-subagents/writer-runtime',
                avatarSeed: 'agent:writer',
                avatarStyle: 'bottts',
              },
            ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          agents: [
            {
              id: 'main',
              description: 'Main runtime agent',
              model: { primary: 'openai/gpt-4.1-mini' },
            },
            {
              id: 'writer',
              description: 'Writes vendor briefs',
              model: 'anthropic/claude-3-7-sonnet',
            },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toMatchObject([
      {
        id: 'main',
        name: 'Main',
        description: 'Main runtime agent',
        workspace: '~/.openclaw/workspace-main-runtime',
        model: 'openai/gpt-4.1-mini',
        isDefault: true,
      },
      {
        id: 'writer',
        name: 'Writer',
        description: 'Writes vendor briefs',
        workspace: '~/.openclaw/workspace-subagents/writer-runtime',
        model: 'anthropic/claude-3-7-sonnet',
        isDefault: false,
      },
    ]);
  });

  it('loadAgents 只从本地 presentation store 合并头像，不读取 openclaw config 里的非法 avatar 字段', async () => {
    const rpc = gatewayClientRpcMock;
    window.localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify({
      writer: {
        avatarSeed: 'picker:writer:page:2:option:5',
        avatarStyle: 'botttsNeutral',
      },
    }));
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main' },
            { id: 'writer', name: 'Writer' },
          ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          agents: [
            {
              id: 'main',
              workspace: '~/.openclaw/workspace-main-config',
              model: { primary: 'openai/gpt-4.1-mini' },
              avatarSeed: 'illegal:main',
              avatarStyle: 'bottts',
            },
            {
              id: 'writer',
              workspace: '~/.openclaw/workspace-subagents/writer-config',
              model: 'anthropic/claude-3-7-sonnet',
              avatarSeed: 'illegal:writer',
              avatarStyle: 'pixelArt',
            },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toMatchObject([
      {
        id: 'main',
        avatarSeed: undefined,
        avatarStyle: undefined,
      },
      {
        id: 'writer',
        avatarSeed: 'picker:writer:page:2:option:5',
        avatarStyle: 'botttsNeutral',
      },
    ]);
  });

  it('propagates files.get failures instead of replacing persisted files with empty content', async () => {
    gatewayClientRpcMock.mockImplementation(async (method) => {
      if (method === 'agents.files.get') {
        throw new Error('Subagent mutation outcome is unknown');
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await expect(useSubagentsStore.getState().loadPersistedFilesForAgent('writer'))
      .rejects.toThrow('Subagent mutation outcome is unknown');
    expect(useSubagentsStore.getState().persistedFilesByAgent.writer).toBeUndefined();
  });

  it('exportAgentConfig 导出可共享配置，不包含本机 workspace', async () => {
    const rpc = gatewayClientRpcMock;
    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          description: 'Reusable writing agent',
          workspace: '/home/dev/.openclaw/workspace-subagents/writer',
          model: 'custom/team-gpt',
          skills: ['web-search', 'feishu-doc'],
          isDefault: false,
        },
      ],
    });
    const callId = 'b'.repeat(32);
    vi.spyOn(hostApiModule, 'hostApiFetchDecoded').mockImplementationOnce(async (_path, decode) => decode({
      callId,
      command: 'skills.bundles.export',
      result: {
        kind: 'bundleExport',
        outcome: 'accepted',
        skillBundles: [
          { skillKey: 'web-search', files: [{ path: 'SKILL.md', content: 'web skill' }] },
          { skillKey: 'feishu-doc', files: [{ path: 'SKILL.md', content: 'feishu skill' }] },
        ],
      },
    }));
    hostApiFetchMock.mockImplementation(async (path, options) => {
      expect(path).toBe('/api/subagents/skill-bundles/export');
      expect(options).toEqual({
        method: 'POST',
        body: JSON.stringify({ skillKeys: ['web-search', 'feishu-doc'] }),
      });
      vi.mocked(getCall).mockResolvedValueOnce({
        callId, module: 'skills', command: 'skills.bundles.export', status: 'succeeded',
        start: 0, end: 1, revision: 1,
        detail: { access: 'read', resultReady: true, result: 'accepted', outcome: 'succeeded', bundleCount: 2, fileCount: 2 },
      });
      return { callId, accepted: true };
    });
    rpc.mockImplementation(async (method, params) => {
      if (method === 'agents.files.get') {
        const fileName = (params as { name?: string }).name;
        return {
          success: true,
          result: {
            file: {
              content: `${fileName} shared content`,
            },
          },
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    const exported = await useSubagentsStore.getState().exportAgentConfig('writer');

    expect(exported).toEqual({
      schema: 'matchaclaw.agent-config',
      version: 1,
      agent: {
        name: 'Writer',
        description: 'Reusable writing agent',
        skills: ['web-search', 'feishu-doc'],
        skillBundles: [
          {
            skillKey: 'web-search',
            files: [{ path: 'SKILL.md', content: 'web skill' }],
          },
          {
            skillKey: 'feishu-doc',
            files: [{ path: 'SKILL.md', content: 'feishu skill' }],
          },
        ],
        files: {
          'AGENTS.md': 'AGENTS.md shared content',
          'SOUL.md': 'SOUL.md shared content',
          'USER.md': 'USER.md shared content',
          'MEMORY.md': 'MEMORY.md shared content',
        },
      },
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/subagents/files/get', expect.anything());
    expect(JSON.stringify(exported)).not.toContain('/home/dev/.openclaw');
  });

  it('exportAgentPackage 通过 sealed package capability 返回公开 receipt', async () => {
    useSubagentsStore.setState({
      agents: [
        { id: 'writer', name: 'Writer', sealed: true, isDefault: false },
      ],
    });
    const callId = 'e'.repeat(32);
    vi.mocked(getCall).mockResolvedValueOnce({
      callId, module: 'subagents', command: 'subagents.package.export', status: 'succeeded',
      start: 0, end: 1, revision: 1,
      detail: { endpoint: 'openclaw:local', agentId: 'writer', runId: null, outcome: 'packageExported', readFailure: null },
    });
    hostApiFetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/subagents/results') {
        expect(JSON.parse(String(options?.body))).toEqual({ callId, operationId: 'subagents.package.export', endpoint: runtimeEndpoint, agentId: 'writer' });
        return {
          callId, operationId: 'subagents.package.export', status: 200,
          body: { success: true, package: { agentId: 'writer', fileName: 'writer.matcha-agentpkg', size: 1024, exportedAtMs: 1 } },
        };
      }
      expect(path).toBe('/api/subagents/agents');
      expect(JSON.parse(String(options?.body))).toEqual({
        id: 'subagent.management',
        operationId: 'subagents.package.export',
        scope: { kind: 'agent', endpoint: runtimeEndpoint, agentId: 'default' },
        target: { kind: 'subagent', subagentId: 'writer' },
        input: { kind: 'packageExport', endpoint: runtimeEndpoint, agentId: 'writer' },
      });
      return { callId, accepted: true };
    });

    await expect(useSubagentsStore.getState().exportAgentPackage('writer')).resolves.toEqual({
      agentId: 'writer',
      fileName: 'writer.matcha-agentpkg',
      size: 1024,
      exportedAtMs: 1,
    });
  });

  it('agent package cloud actions use the package registry endpoints', async () => {
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({
      agents: [
        { id: 'writer', name: 'Writer', isDefault: false },
      ],
      loadAgents,
    });
    const uploadOperationId = 'cloud-package:00000000-0000-4000-8000-000000000001';
    const installOperationId = 'cloud-package:00000000-0000-4000-8000-000000000002';
    hostApiFetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/packages/upload/sealed-agent') {
        expect(JSON.parse(String(options?.body))).toEqual({ agentId: 'writer' });
        expect(String(options?.body)).not.toMatch(/packagePath|deviceEnvelope|authorizationKey|contentKey|rawPayload|token/);
        return { operationId: uploadOperationId, accepted: true };
      }
      if (path === '/api/packages/operation-result') {
        const { operationId } = JSON.parse(String(options?.body));
        if (operationId === uploadOperationId) return {
          operationId, kind: 'uploadSealedAgent', state: 'succeeded',
          result: { packageId: 'pkg-writer', packageVersionId: 'version-writer', name: 'writer.matcha-agentpkg', packageType: 'agent', version: 'v1', status: 'draft', downloadable: false },
        };
        expect(operationId).toBe(installOperationId);
        return {
          operationId, kind: 'install', state: 'succeeded',
          result: { packageVersionId: 'version-writer', filename: 'writer.matcha-agentpkg', bytes: 1024, packageSha256: 'a'.repeat(64), install: { callId: 'c'.repeat(32), accepted: true } },
        };
      }
      if (path === '/api/packages/mine?packageType=agent' || path === '/api/packages/market?packageType=agent') return { items: [] };
      if (path === '/api/packages/installed') return { packages: [] };
      if (path === '/api/packages/install') {
        expect(JSON.parse(String(options?.body))).toEqual({ packageVersionId: 'version-writer', packageType: 'agent', source: 'subagents' });
        expect(String(options?.body)).not.toMatch(/packagePath|deviceEnvelope|authorizationKey|contentKey|rawPayload|token/);
        const callId = 'c'.repeat(32);
        vi.mocked(getCall).mockResolvedValueOnce({
          callId, module: 'subagents', command: 'subagents.package.install', status: 'succeeded',
          start: 0, end: 1, revision: 1,
          detail: { endpoint: 'openclaw:local', agentId: 'writer', runId: null, outcome: 'packageInstalled', readFailure: null },
        });
        return { operationId: installOperationId, accepted: true };
      }
      if (path === '/api/subagents/results') {
        return { callId: 'c'.repeat(32), operationId: 'subagents.package.install', status: 200, body: { success: true, package: { agentId: 'writer' } } };
      }
      if (path === '/api/packages/install/confirm') {
        return { packageId: 'pkg-writer', packageVersionId: 'version-writer', install: { outcome: 'accepted', agentId: 'writer' } };
      }
      throw new Error(`Unexpected path in test: ${String(path)}`);
    });

    await expect(useSubagentsStore.getState().uploadAgentPackageToCloud('writer')).resolves.toEqual({
      agentId: 'writer',
      packageId: 'pkg-writer',
      packageVersionId: 'version-writer',
      fileName: 'writer.matcha-agentpkg',
      size: undefined,
      uploadedAtMs: expect.any(Number),
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/mine?packageType=agent', undefined);
    expect(hostApiFetchMock.mock.calls.some(([path]) => String(path).endsWith('/publish'))).toBe(false);
    await expect(useSubagentsStore.getState().installAgentPackageFromCloud('version-writer')).resolves.toEqual({
      agentId: 'writer',
      packageId: 'pkg-writer',
      packageVersionId: 'version-writer',
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/subagents/agents', expect.anything());
    expect(loadAgents).toHaveBeenCalledTimes(1);
  });

  it('lists mine drafts and publishes the direct package version receipt', async () => {
    const draft = { packageId: 'mine', packageVersionId: 'draft-id', name: 'Writer', packageType: 'agent', version: 'a'.repeat(64), status: 'draft', downloadable: false };
    hostApiFetchMock.mockImplementation(async (path) => {
      if (path === '/api/packages/mine?packageType=agent') return { items: [draft] };
      if (path === '/api/packages/draft-id/publish') return { ...draft, status: 'published' };
      if (path === '/api/packages/installed') return { packages: [] };
      return { items: [] };
    });
    await useSubagentsStore.getState().loadMyCloudPackages();
    expect(useSubagentsStore.getState().myCloudPackages).toEqual([draft]);
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    await useSubagentsStore.getState().publishCloudAgentPackage('draft-id');
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/draft-id/publish', { method: 'POST' });
    expect(useSubagentsStore.getState().myCloudPackages[0].status).toBe('published');
    expect(useSubagentsStore.getState().cloudPublishingByVersionId).toEqual({});
  });

  it('maps package install unknown outcome to an actionable user message', async () => {
    hostApiFetchMock.mockImplementation(async (path) => {
      if (path === '/api/packages/install') {
        throw new Error('Subagent mutation outcome is unknown');
      }
      throw new Error(`Unexpected path in test: ${String(path)}`);
    });

    await expect(useSubagentsStore.getState().installAgentPackageFromCloud('version-writer'))
      .rejects.toThrow(i18n.t('subagents:transfer.installPackageUnknownOutcome'));
  });

  it('exportAgentConfig rejects sealed agents before reading editable files', async () => {
    useSubagentsStore.setState({
      agents: [
        { id: 'writer', name: 'Writer', sealed: true, isDefault: false },
      ],
    });

    await expect(useSubagentsStore.getState().exportAgentConfig('writer'))
      .rejects.toThrow('Sealed agent config cannot be exported');
    expect(gatewayClientRpcMock).not.toHaveBeenCalledWith('agents.files.get', expect.anything(), expect.anything());
  });

  it('importAgentConfig 从共享配置创建 agent 并写入人设文件', async () => {
    const rpc = gatewayClientRpcMock;
    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'Main', workspace: '/home/dev/.openclaw/workspace', isDefault: true },
      ],
    });
    hostApiFetchMock.mockImplementation(async (path, options) => {
      expect(path).toBe('/api/subagents/skill-bundles/import');
      expect(options).toEqual({
        method: 'POST',
        body: JSON.stringify({
          skillBundles: [
            {
              skillKey: 'web-search',
              files: [{ path: 'SKILL.md', content: 'web skill' }],
            },
          ],
        }),
      });
      const callId = 'd'.repeat(32);
      vi.mocked(getCall).mockResolvedValueOnce({
        callId, module: 'skills', command: 'skills.bundles.import', status: 'succeeded',
        start: 0, end: 1, revision: 1,
        detail: { access: 'write', outcome: 'succeeded', bundleCount: 1 },
      });
      return { callId, accepted: true };
    });
    rpc.mockImplementation(async (method, params) => {
      if (method === 'agents.create') {
        expect(params).toEqual({
          kind: 'create',
          endpoint: runtimeEndpoint,
          name: 'Writer',
          workspace: '/home/dev/.openclaw/workspace-subagents/writer',
          model: null,
          workspaceInitialization: 'emptyWorkspace',
        });
        return { success: true, result: { agentId: 'writer' } };
      }
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'writer' }],
          },
        };
      }
      if (method === 'displayConfig.get') {
        return {
          success: true,
          result: displayConfigResult({
            agents: [{ id: 'writer', model: 'custom/team-gpt', skills: ['web-search'] }],
          }),
        };
      }
      if (method === 'skills.set') {
        expect(params).toEqual({ kind: 'setSkills', endpoint: runtimeEndpoint, agentId: 'writer', skills: ['web-search'] });
        return { success: true, result: {} };
      }
      if (method === 'agents.files.set') {
        return { success: true, result: {} };
      }
      if (method === 'agents.files.get') {
        return { success: true, result: { file: { content: '' } } };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    const result = await useSubagentsStore.getState().importAgentConfig({
      schema: 'matchaclaw.agent-config',
      version: 1,
      agent: {
        name: 'Writer',
        skills: ['web-search'],
        skillBundles: [
          {
            skillKey: 'web-search',
            files: [{ path: 'SKILL.md', content: 'web skill' }],
          },
        ],
        files: {
          'AGENTS.md': 'agents content',
          'SOUL.md': 'soul content',
        },
      },
    });

    expect(result).toEqual({ agentId: 'writer' });
    expect(rpc).toHaveBeenCalledWith(
      'agents.files.set',
      { kind: 'filesSet', endpoint: runtimeEndpoint, agentId: 'writer', name: 'AGENTS.md', content: 'agents content' },
      undefined,
    );
    expect(rpc).toHaveBeenCalledWith(
      'agents.files.set',
      { kind: 'filesSet', endpoint: runtimeEndpoint, agentId: 'writer', name: 'SOUL.md', content: 'soul content' },
      undefined,
    );
    expect(rpc).not.toHaveBeenCalledWith('agents.update', expect.anything(), undefined);
    expect(window.localStorage.getItem(AVATAR_STORAGE_KEY)).toBeNull();
  });

  it('loadAvailableModels 从模型清单读取可选模型', async () => {
    hostApiFetchMock.mockResolvedValue({
      models: [
        {
          accountId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          selectionId: 'model-selection:v1:4444444444444444444444444444444444444444444444444444444444444444',
          label: '自定义',
          modelId: 'gpt-5.4',
          capabilities: ['chat'],
          contextWindow: 200000,
          modelReferences: ['custom-dd749b2e/gpt-5.4'],
        },
        {
          accountId: 'ark',
          selectionId: 'model-selection:v1:5555555555555555555555555555555555555555555555555555555555555555',
          label: 'Ark Code',
          modelId: 'ark-code-latest',
          capabilities: ['chat'],
          modelReferences: ['ark/ark-code-latest'],
        },
      ],
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'model-selection:v1:4444444444444444444444444444444444444444444444444444444444444444',
        provider: '自定义',
        accountId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
        providerLabel: '自定义',
        modelLabel: 'gpt-5.4',
        displayLabel: '自定义 / gpt-5.4',
        contextWindow: 200000,
        maxTokens: undefined,
        modelReferences: ['custom-dd749b2e/gpt-5.4'],
      }),
      expect.objectContaining({
        id: 'model-selection:v1:5555555555555555555555555555555555555555555555555555555555555555',
        provider: 'Ark Code',
        accountId: 'ark',
        providerLabel: 'Ark Code',
        modelLabel: 'ark-code-latest',
        displayLabel: 'Ark Code / ark-code-latest',
        contextWindow: undefined,
        maxTokens: undefined,
        modelReferences: ['ark/ark-code-latest'],
      }),
    ]));
    expect(useSubagentsStore.getState().availableModels).toHaveLength(2);
  });

  it('loadAvailableModels force 刷新会替换已缓存的可选模型', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        models: [{
          accountId: 'removed',
          selectionId: 'model-selection:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          label: 'Removed',
          modelId: 'old-model',
          capabilities: ['chat'],
          modelReferences: ['removed/old-model'],
        }],
      })
      .mockResolvedValueOnce({
        models: [{
          accountId: 'retained',
          selectionId: 'model-selection:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          label: 'Retained',
          modelId: 'new-model',
          capabilities: ['chat'],
          modelReferences: ['retained/new-model'],
        }],
      });

    await useSubagentsStore.getState().loadAvailableModels();
    await useSubagentsStore.getState().loadAvailableModels();

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(useSubagentsStore.getState().availableModels).toEqual([
      expect.objectContaining({ accountId: 'removed', modelLabel: 'old-model' }),
    ]);

    await useSubagentsStore.getState().loadAvailableModels({ force: true });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
    expect(useSubagentsStore.getState().availableModels).toEqual([
      expect.objectContaining({ accountId: 'retained', modelLabel: 'new-model' }),
    ]);
  });

  it('loadAvailableModels 不从 provider store snapshot 推断模型', async () => {
    hostApiFetchMock.mockResolvedValue({ models: [] });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/provider-models/selectable?capability=chat', undefined);
  });

  it('loadAvailableModels 不再从 browser oauth 凭证推断模型', async () => {
    hostApiFetchMock.mockResolvedValue({ models: [] });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
  });

  it('模型清单为空时，loadAvailableModels 返回空列表', async () => {
    hostApiFetchMock.mockResolvedValue({ models: [] });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
  });

  it('loadAvailableModels 在模型清单读取失败时安全降级为空', async () => {
    hostApiFetchMock.mockRejectedValueOnce(new Error('provider models failed'));

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
  });

  it('loadAgents 仅按配置模型显示，不做运行时回填', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', model: 'custom/removed-main-model', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
            { id: 'writer', name: 'Writer', model: 'openai/gpt-4.1-mini', avatarSeed: 'agent:writer', avatarStyle: 'bottts' },
          ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          defaults: {
            model: { primary: 'custom/removed-main-model' },
          },
          agents: [
            { id: 'main', model: 'custom/removed-main-model' },
            { id: 'writer', model: 'openai/gpt-4.1-mini' },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toMatchObject([
      {
        id: 'main',
        name: 'Main',
        model: 'custom/removed-main-model',
      },
      {
        id: 'writer',
        name: 'Writer',
        model: 'openai/gpt-4.1-mini',
      },
    ]);
    expect(rpc).not.toHaveBeenCalledWith('model.set', expect.anything());
  });

  it('loadAgents 在多模型场景下仍保持配置模型值', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', model: 'custom/removed-main-model', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
            { id: 'writer', name: 'Writer', model: 'openai/gpt-4.1-mini', avatarSeed: 'agent:writer', avatarStyle: 'bottts' },
          ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          defaults: {
            model: { primary: 'custom/removed-main-model' },
          },
          agents: [
            { id: 'main', model: 'custom/removed-main-model' },
            { id: 'writer', model: 'openai/gpt-4.1-mini' },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toMatchObject([
      {
        id: 'main',
        name: 'Main',
        model: 'custom/removed-main-model',
      },
      {
        id: 'writer',
        name: 'Writer',
        model: 'openai/gpt-4.1-mini',
      },
    ]);
    expect(rpc).not.toHaveBeenCalledWith('model.set', expect.anything());
    expect(rpc).not.toHaveBeenCalledWith(
      'agents.update',
      expect.anything(),
    );
  });

  it('loadAgents 不应用 defaults.model.fallbacks 的运行时回填', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', model: 'custom/removed-main-model', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
            { id: 'writer', name: 'Writer', model: 'openai/gpt-4.1-mini', avatarSeed: 'agent:writer', avatarStyle: 'bottts' },
          ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          defaults: {
            model: {
              primary: 'custom/removed-main-model',
              fallbacks: ['anthropic/claude-3-7-sonnet', 'openai/gpt-4.1-mini'],
            },
          },
          agents: [
            { id: 'main', model: 'custom/removed-main-model' },
            { id: 'writer', model: 'openai/gpt-4.1-mini' },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toMatchObject([
      {
        id: 'main',
        model: 'custom/removed-main-model',
      },
      {
        id: 'writer',
        model: 'openai/gpt-4.1-mini',
      },
    ]);
  });

  it('loadAgents 在无可用模型时仍保留配置模型展示值', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', model: 'openai/gpt-4.1-mini', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
            { id: 'writer', name: 'Writer', model: 'anthropic/claude-3-7-sonnet', avatarSeed: 'agent:writer', avatarStyle: 'bottts' },
          ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          defaults: {
            model: { primary: 'openai/gpt-4.1-mini' },
          },
          agents: [
            { id: 'main', model: 'openai/gpt-4.1-mini' },
            { id: 'writer', model: 'anthropic/claude-3-7-sonnet' },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toMatchObject([
      { id: 'main', name: 'Main', model: 'openai/gpt-4.1-mini' },
      { id: 'writer', name: 'Writer', model: 'anthropic/claude-3-7-sonnet' },
    ]);
    expect(rpc).not.toHaveBeenCalledWith('model.set', expect.anything());
  });

  it('loadAgents 不依赖运行时模型目录', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', model: 'custom/removed-main-model' },
            { id: 'writer', name: 'Writer', model: 'openai/gpt-4.1-mini' },
          ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          defaults: {
            model: { primary: 'custom/removed-main-model' },
          },
          agents: [
            { id: 'main', model: 'custom/removed-main-model' },
            { id: 'writer', model: 'openai/gpt-4.1-mini' },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toMatchObject([
      { id: 'main', model: 'custom/removed-main-model' },
      { id: 'writer', model: 'openai/gpt-4.1-mini' },
    ]);
  });

  it('loadAgents 在配置列表与运行时列表不一致时，以运行时列表为真相源', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
            { id: 'test4', name: 'test4', model: 'local/claude-sonnet-4.5' },
          ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          agents: [{ id: 'main', name: 'Main' }],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    const agents = useSubagentsStore.getState().agents;
    expect(agents.map((item) => item.id)).toEqual(['main', 'test4']);
  });

  it('loadAgents 不强制注入 main，仅按运行时 agents.list 集合渲染', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [{ id: 'ontology-expert', name: 'Ontology-Expert' }],
          defaultId: 'ontology-expert',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          agents: [
            { id: 'ontology-expert', name: 'Ontology-Expert' },
            { id: 'business-expert', name: 'Business-expert' },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    const agents = useSubagentsStore.getState().agents;
    expect(agents.map((item) => item.id)).toEqual(['ontology-expert']);
  });

  it('loadAgents 在运行时列表缺失 agent 时，不从配置列表补齐', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [{ id: 'main', name: 'Main', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' }],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: displayConfigResult({
          agents: [
            { id: 'main', name: 'Main' },
            { id: 'test6', name: 'test6', model: 'local/claude-sonnet-4.5' },
          ],
        }),
      });

    await useSubagentsStore.getState().loadAgents();

    const agents = useSubagentsStore.getState().agents;
    expect(agents.map((item) => item.id)).toEqual(['main']);
  });

  it('loadAgents 在运行时列表缺失 agent 时，不从配置列表补齐（配置补水路径）', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockImplementation(async (method) => {
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'main', name: 'Main', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' }],
            defaultId: 'main',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().loadAgents();

    const agents = useSubagentsStore.getState().agents;
    expect(agents.map((item) => item.id)).toEqual(['main']);
  });

  it('loadAgents 默认选中标记只跟随 runtime 的 defaultId，不写死 main', async () => {
    const rpc = gatewayClientRpcMock;
    rpc
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'dev', name: 'Dev' },
            { id: 'main', name: 'Main' },
          ],
          defaultId: 'dev',
          mainKey: 'main',
          scope: 'per-sender',
        },
      });

    await useSubagentsStore.getState().loadAgents();

    const agents = useSubagentsStore.getState().agents;
    const dev = agents.find((item) => item.id === 'dev');
    const main = agents.find((item) => item.id === 'main');
    expect(dev).toMatchObject({
      id: 'dev',
      isDefault: true,
    });
    expect(main).toMatchObject({
      id: 'main',
      isDefault: false,
    });
  });

  it('loadAgents 并发请求时，仅最后一次结果可以落库', async () => {
    const rpc = gatewayClientRpcMock;
    let resolveFirstList: ((value: unknown) => void) | null = null;
    const firstListPromise = new Promise((resolve) => {
      resolveFirstList = resolve;
    });
    let agentsListCallCount = 0;

    rpc.mockImplementation(async (method) => {
      if (method === 'agents.list') {
        agentsListCallCount += 1;
        if (agentsListCallCount === 1) {
          return firstListPromise as Promise<unknown>;
        }
        return {
          success: true,
          result: {
            agents: [{ id: 'main', name: 'Main-new' }],
            defaultId: 'main',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      if (method === 'displayConfig.get') {
        return { success: true, result: displayConfigResult() };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    const firstLoadTask = useSubagentsStore.getState().loadAgents();
    const secondLoadTask = useSubagentsStore.getState().loadAgents();

    resolveFirstList?.({
      success: true,
      result: {
        agents: [{ id: 'main', name: 'Main-old' }],
        defaultId: 'main',
        mainKey: 'main',
        scope: 'per-sender',
      },
    });

    await Promise.all([firstLoadTask, secondLoadTask]);

    const agents = useSubagentsStore.getState().agents;
    expect(agents).toMatchObject([{ id: 'main', name: 'Main-new' }]);
    expect(useSubagentsStore.getState().agentsResource.status).toBe('ready');
  });

  it('deleteAgent 后，旧的 agents.list 结果不会把待删 agent 回显', async () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/workspace/main',
          model: 'openai/gpt-4.1-mini',
          isDefault: true,
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
        },
        {
          id: 'ghost-delete-003',
          name: 'ghost-delete-003',
          workspace: '/workspace/ghost-delete-003',
          model: 'local/claude-sonnet-4.5',
          isDefault: false,
          avatarSeed: 'agent:ghost-delete-003',
          avatarStyle: 'botttsNeutral',
        },
      ],
    });

    const rpc = gatewayClientRpcMock;
    rpc.mockImplementation(async (method, params) => {
      if (method === 'agents.delete') {
        expect(params).toEqual({ kind: 'delete', endpoint: runtimeEndpoint, agentId: 'ghost-delete-003', deleteFiles: true });
        return { success: true, result: { ok: true } };
      }
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [
              { id: 'main', name: 'Main', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
              { id: 'ghost-delete-003', name: 'ghost-delete-003', avatarSeed: 'agent:ghost-delete-003', avatarStyle: 'botttsNeutral' },
            ],
            defaultId: 'main',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().deleteAgent('ghost-delete-003');
    expect(useSubagentsStore.getState().agents.map((agent) => agent.id)).toEqual(['main']);

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents.map((agent) => agent.id)).toEqual(['main']);
  });

  it('deleteAgent 成功后立即从前端列表移除，不阻塞等待 runtime 刷新', async () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/workspace/main',
          model: 'openai/gpt-4.1-mini',
          isDefault: true,
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
        },
        {
          id: 'ghost-delete-001',
          name: 'ghost-delete-001',
          workspace: '/workspace/ghost-delete-001',
          model: 'local/claude-sonnet-4.5',
          isDefault: false,
          avatarSeed: 'agent:ghost-delete-001',
          avatarStyle: 'botttsNeutral',
        },
      ],
    });

    const rpc = gatewayClientRpcMock;
    rpc.mockImplementation(async (method: unknown, params: unknown) => {
      if (method === 'agents.delete') {
        expect(params).toEqual({ kind: 'delete', endpoint: runtimeEndpoint, agentId: 'ghost-delete-001', deleteFiles: true });
        return { success: true, result: { ok: true } };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().deleteAgent('ghost-delete-001');

    const agents = useSubagentsStore.getState().agents;
    expect(agents.map((item) => item.id)).toEqual(['main']);
    expect(rpc).not.toHaveBeenCalledWith('agents.list', {});
  });
});
