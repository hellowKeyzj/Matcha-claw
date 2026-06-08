import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capabilityExecuteMock,
  gatewayClientRpcMock,
  hostApiFetchMock,
  resetGatewayClientMocks,
} from './helpers/mock-gateway-client';

import { useSubagentsStore } from '@/stores/subagents';

const AVATAR_STORAGE_KEY = 'matchaclaw-subagent-avatar-presentations';
const runtimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};
const runtimeInstanceScope = {
  kind: 'runtime-instance',
  endpoint: runtimeEndpoint,
};

describe('subagents store', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
    window.localStorage.removeItem(AVATAR_STORAGE_KEY);
    useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
  });

  it('loads agents.list via gateway rpc', async () => {
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
      {},
      undefined,
    );
    expect(capabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'subagent.management',
      operationId: 'subagents.list',
      scope: {
        kind: 'agent',
        endpoint: runtimeEndpoint,
        agentId: 'default',
      },
      target: { kind: 'agent', agentId: 'default' },
      input: {},
    }), { timeoutMs: undefined });
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

  it('loadAgents 遇到 runtime-host not-ready 时保持 loading 并等待重试', async () => {
    vi.useFakeTimers();
    try {
      gatewayClientRpcMock.mockResolvedValueOnce({
        success: true,
        result: {
          success: true,
          agents: [],
          ready: false,
          refreshing: true,
          updatedAt: null,
          error: null,
        },
      });

      await useSubagentsStore.getState().loadAgents();

      const state = useSubagentsStore.getState();
      expect(state.agentsResource.status).toBe('loading');
      expect(state.agentsResource.hasLoadedOnce).toBe(false);
      expect(state.agents).toEqual([]);
      expect(gatewayClientRpcMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loadAgents 与 loadAvailableModels 并发时，只有 loadAgents 会读取 config.get', async () => {
    const rpc = gatewayClientRpcMock;
    let resolveConfigGet: ((value: unknown) => void) | null = null;
    const configGetTask = new Promise((resolve) => {
      resolveConfigGet = resolve;
    });
    capabilityExecuteMock.mockImplementation(async () => ({ models: [] }));
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
      if (method === 'config.get') {
        return configGetTask as Promise<unknown>;
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    const loadAgentsTask = useSubagentsStore.getState().loadAgents();
    const loadModelsTask = useSubagentsStore.getState().loadAvailableModels();
    resolveConfigGet?.({
      success: true,
      result: {
        config: {
          agents: {
            list: [{ id: 'main', model: 'openai/gpt-4.1-mini' }],
          },
        },
      },
    });

    await Promise.all([loadAgentsTask, loadModelsTask]);

    const configGetCalls = rpc.mock.calls.filter(
      ([method]) => method === 'config.get'
    );
    expect(configGetCalls).toHaveLength(1);
    expect(rpc).not.toHaveBeenCalledWith('models.list', {}, undefined);
    expect(capabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'model.provider',
      operationId: 'providerModels.listSelectable',
      scope: runtimeInstanceScope,
      target: null,
      input: {},
    }), { timeoutMs: undefined });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/provider-models', undefined);
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/provider-accounts', undefined);
  });

  it('短 TTL 内重复 loadAgents 复用 config.get 结果', async () => {
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
      if (method === 'config.get') {
        return {
          success: true,
          result: {
            config: {
              agents: {
                list: [{ id: 'main', workspace: '/workspace/main' }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().loadAgents();
    await useSubagentsStore.getState().loadAgents();

    const configGetCalls = rpc.mock.calls.filter(
      ([method]) => method === 'config.get'
    );
    expect(configGetCalls).toHaveLength(1);
  });

  it('loadAgents 使用 config.get 补齐 workspace/model，且不使用旧 store 回填', async () => {
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
              { id: 'main', name: 'Main', avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
              { id: 'writer', name: 'Writer', avatarSeed: 'agent:writer', avatarStyle: 'bottts' },
            ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          config: {
            agents: {
              list: [
                {
                  id: 'main',
                  workspace: '~/.openclaw/workspace-main-config',
                  model: { primary: 'openai/gpt-4.1-mini' },
                },
                {
                  id: 'writer',
                  workspace: '~/.openclaw/workspace-subagents/writer-config',
                  model: 'anthropic/claude-3-7-sonnet',
                },
              ],
            },
          },
        },
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toMatchObject([
      {
        id: 'main',
        name: 'Main',
        workspace: '~/.openclaw/workspace-main-config',
        model: 'openai/gpt-4.1-mini',
        isDefault: true,
      },
      {
        id: 'writer',
        name: 'Writer',
        workspace: '~/.openclaw/workspace-subagents/writer-config',
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
        result: {
          config: {
            agents: {
              list: [
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
            },
          },
        },
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

  it('exportAgentConfig 导出可共享配置，不包含本机 workspace', async () => {
    const rpc = gatewayClientRpcMock;
    useSubagentsStore.setState({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          workspace: '/home/dev/.openclaw/workspace-subagents/writer',
          model: 'custom/team-gpt',
          skills: ['web-search', 'feishu-doc'],
          isDefault: false,
        },
      ],
    });
    capabilityExecuteMock.mockImplementation(async (payload) => {
      expect(payload).toEqual(expect.objectContaining({
        id: 'skill.management',
        operationId: 'skills.exportBundles',
        scope: runtimeInstanceScope,
        target: { kind: 'skill-bundle' },
        input: { skillKeys: ['web-search', 'feishu-doc'] },
      }));
      return [
        {
          skillKey: 'web-search',
          files: [{ path: 'SKILL.md', content: 'web skill' }],
        },
        {
          skillKey: 'feishu-doc',
          files: [{ path: 'SKILL.md', content: 'feishu skill' }],
        },
      ];
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
          'TOOLS.md': 'TOOLS.md shared content',
          'IDENTITY.md': 'IDENTITY.md shared content',
          'USER.md': 'USER.md shared content',
        },
      },
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/subagents/files/get', expect.anything());
    expect(JSON.stringify(exported)).not.toContain('/home/dev/.openclaw');
  });

  it('importAgentConfig 从共享配置创建 agent 并写入人设文件', async () => {
    const rpc = gatewayClientRpcMock;
    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'Main', workspace: '/home/dev/.openclaw/workspace', isDefault: true },
      ],
    });
    capabilityExecuteMock.mockImplementation(async (payload) => {
      expect(payload).toEqual(expect.objectContaining({
        id: 'skill.management',
        operationId: 'skills.importBundles',
        scope: runtimeInstanceScope,
        target: { kind: 'skill-bundle' },
        input: {
          skillBundles: [
            {
              skillKey: 'web-search',
              files: [{ path: 'SKILL.md', content: 'web skill' }],
            },
          ],
        },
      }));
      return { ok: true, installed: ['web-search'] };
    });
    rpc.mockImplementation(async (method, params) => {
      if (method === 'agents.create') {
        expect(params).toEqual({
          name: 'Writer',
          workspace: '/home/dev/.openclaw/workspace-subagents/writer',
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
      if (method === 'config.get') {
        return {
          success: true,
          result: {
            hash: 'cfg-hash',
            config: {
              agents: {
                list: [{ id: 'writer', model: 'custom/team-gpt' }],
              },
            },
          },
        };
      }
      if (method === 'config.set') {
        const payload = params as { raw?: string; baseHash?: string };
        expect(payload.baseHash).toBe('cfg-hash');
        const parsed = JSON.parse(payload.raw || '{}') as {
          agents?: { list?: Array<{ id?: string; skills?: string[] }> };
        };
        expect(parsed.agents?.list?.find((entry) => entry.id === 'writer')?.skills).toEqual(['web-search']);
        return { success: true, result: {} };
      }
      if (method === 'agents.files.set') {
        return { success: true, result: {} };
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
      { agentId: 'writer', name: 'AGENTS.md', content: 'agents content' },
      undefined,
    );
    expect(rpc).toHaveBeenCalledWith(
      'agents.files.set',
      { agentId: 'writer', name: 'SOUL.md', content: 'soul content' },
      undefined,
    );
    expect(rpc).not.toHaveBeenCalledWith('agents.update', expect.anything(), undefined);
    expect(window.localStorage.getItem(AVATAR_STORAGE_KEY)).toBeNull();
  });

  it('loadAvailableModels 从模型清单读取可选模型', async () => {
    capabilityExecuteMock.mockImplementation(async () => ({
      models: [
        {
          credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          providerKey: 'custom-dd749b2e',
          runtimeModelRef: 'custom-dd749b2e/gpt-5.4',
          label: '自定义',
          modelId: 'gpt-5.4',
          capabilities: ['chat'],
          contextWindow: 200000,
        },
        {
          credentialId: 'ark',
          providerKey: 'ark',
          runtimeModelRef: 'ark/ark-code-latest',
          label: 'Ark Code',
          modelId: 'ark-code-latest',
          capabilities: ['chat'],
        },
      ],
    }));

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'custom-dd749b2e/gpt-5.4',
        provider: 'custom-dd749b2e',
        credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
        providerLabel: '自定义',
        modelLabel: 'gpt-5.4',
        displayLabel: '自定义 / gpt-5.4',
        contextWindow: 200000,
        maxTokens: undefined,
      }),
      expect.objectContaining({
        id: 'ark/ark-code-latest',
        provider: 'ark',
        credentialId: 'ark',
        providerLabel: 'Ark Code',
        modelLabel: 'ark-code-latest',
        displayLabel: 'Ark Code / ark-code-latest',
        contextWindow: undefined,
        maxTokens: undefined,
      }),
    ]));
    expect(useSubagentsStore.getState().availableModels).toHaveLength(2);
  });

  it('loadAvailableModels 不从 provider store snapshot 推断模型', async () => {
    capabilityExecuteMock.mockImplementation(async () => ({ models: [] }));

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
    expect(capabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'model.provider',
      operationId: 'providerModels.listSelectable',
      scope: runtimeInstanceScope,
      target: null,
      input: {},
    }), { timeoutMs: undefined });
  });

  it('loadAvailableModels 不再从 browser oauth 凭证推断模型', async () => {
    capabilityExecuteMock.mockImplementation(async () => ({ models: [] }));

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
  });

  it('模型清单为空时，loadAvailableModels 返回空列表', async () => {
    capabilityExecuteMock.mockImplementation(async () => ({ models: [] }));

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
  });

  it('loadAvailableModels 在模型清单读取失败时安全降级为空', async () => {
    capabilityExecuteMock.mockRejectedValueOnce(new Error('provider models failed'));

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
        result: {
          hash: 'hash-filter-invalid-model',
          config: {
            agents: {
              defaults: {
                model: { primary: 'custom/removed-main-model' },
              },
              list: [
                { id: 'main', model: 'custom/removed-main-model' },
                { id: 'writer', model: 'openai/gpt-4.1-mini' },
              ],
            },
            models: {
              providers: {
                openai: {
                  models: [{ id: 'gpt-4.1-mini' }],
                },
              },
            },
          },
        },
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
    expect(rpc).not.toHaveBeenCalledWith('config.patch', expect.anything());
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
        result: {
          hash: 'hash-filter-invalid-model-with-multi-options',
          config: {
            agents: {
              defaults: {
                model: { primary: 'custom/removed-main-model' },
              },
              list: [
                { id: 'main', model: 'custom/removed-main-model' },
                { id: 'writer', model: 'openai/gpt-4.1-mini' },
              ],
            },
            models: {
              providers: {
                openai: {
                  models: [{ id: 'gpt-4.1-mini' }],
                },
                anthropic: {
                  models: [{ id: 'claude-3-7-sonnet' }],
                },
              },
            },
          },
        },
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
    expect(rpc).not.toHaveBeenCalledWith('config.patch', expect.anything());
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
        result: {
          hash: 'hash-fallback-priority',
          config: {
            agents: {
              defaults: {
                model: {
                  primary: 'custom/removed-main-model',
                  fallbacks: ['anthropic/claude-3-7-sonnet', 'openai/gpt-4.1-mini'],
                },
              },
              list: [
                { id: 'main', model: 'custom/removed-main-model' },
                { id: 'writer', model: 'openai/gpt-4.1-mini' },
              ],
            },
          },
        },
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
        result: {
          hash: 'hash-no-models',
          config: {
            agents: {
              defaults: {
                model: { primary: 'openai/gpt-4.1-mini' },
              },
              list: [
                { id: 'main', model: 'openai/gpt-4.1-mini' },
                { id: 'writer', model: 'anthropic/claude-3-7-sonnet' },
              ],
            },
            models: {
              providers: {},
            },
          },
        },
      });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toMatchObject([
      { id: 'main', name: 'Main', model: 'openai/gpt-4.1-mini' },
      { id: 'writer', name: 'Writer', model: 'anthropic/claude-3-7-sonnet' },
    ]);
    expect(rpc).not.toHaveBeenCalledWith('config.patch', expect.anything());
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
        result: {
          config: {
            agents: {
              defaults: {
                model: { primary: 'custom/removed-main-model' },
              },
              list: [
                { id: 'main', model: 'custom/removed-main-model' },
                { id: 'writer', model: 'openai/gpt-4.1-mini' },
              ],
            },
          },
        },
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
        result: {
          config: {
            agents: {
              list: [{ id: 'main', name: 'Main' }],
            },
          },
        },
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
        result: {
          config: {
            agents: {
              list: [
                { id: 'ontology-expert', name: 'Ontology-Expert' },
                { id: 'business-expert', name: 'Business-expert' },
              ],
            },
          },
        },
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
        result: {
          config: {
            agents: {
              list: [
                { id: 'main', name: 'Main' },
                { id: 'test6', name: 'test6', model: 'local/claude-sonnet-4.5' },
              ],
            },
          },
        },
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
        expect(params).toEqual({ agentId: 'ghost-delete-003', deleteFiles: true });
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
        expect(params).toEqual({ agentId: 'ghost-delete-001', deleteFiles: true });
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
