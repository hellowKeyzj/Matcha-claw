import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gatewayClientRpcMock,
  hostApiFetchMock,
  resetGatewayClientMocks,
} from './helpers/mock-gateway-client';

import { useProviderStore } from '@/stores/providers';
import { useSubagentsStore } from '@/stores/subagents';

const AVATAR_STORAGE_KEY = 'clawx-subagent-avatar-presentations';

describe('subagents store', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
    window.localStorage.removeItem(AVATAR_STORAGE_KEY);
    useProviderStore.setState({
      providerSnapshot: {
        accounts: [],
        statuses: [],
        vendors: [],
        defaultAccountId: null,
      },
      snapshotReady: false,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      mutatingActionsByAccountId: {},
      error: null,
    });
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

  it('loadAgents 与 loadAvailableModels 并发时，只有 loadAgents 会读取 config.get', async () => {
    const rpc = gatewayClientRpcMock;
    let resolveConfigGet: ((value: unknown) => void) | null = null;
    const configGetTask = new Promise((resolve) => {
      resolveConfigGet = resolve;
    });
    hostApiFetchMock.mockResolvedValue({
      accounts: [
        {
          id: 'openai-main',
          vendorId: 'openai',
          label: 'OpenAI',
          authMode: 'api_key',
          model: 'gpt-4.1-mini',
          enabled: true,
          isDefault: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      statuses: [],
      vendors: [
        {
          id: 'openai',
          name: 'OpenAI',
          defaultModelId: 'gpt-5.4',
          supportedAuthModes: ['api_key', 'oauth_browser'],
          defaultAuthMode: 'api_key',
          supportsMultipleAccounts: true,
        },
      ],
      defaultAccountId: 'openai-main',
    });
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
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/provider-accounts', undefined);
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

  it('loadAvailableModels 从 provider snapshot 生成已配置模型选项', async () => {
    hostApiFetchMock.mockResolvedValue({
      accounts: [
        {
          id: 'custom-12345678',
          vendorId: 'custom',
          label: 'Custom A',
          authMode: 'api_key',
          model: 'gpt-4o-mini',
          contextWindow: 200000,
          maxTokens: 64000,
          enabled: true,
          isDefault: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
        },
        {
          id: 'ollama-87654321',
          vendorId: 'ollama',
          label: 'Local Ollama',
          authMode: 'local',
          model: 'qwen3:latest',
          fallbackModels: ['llama3.1:8b'],
          enabled: true,
          isDefault: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'openai-main',
          vendorId: 'openai',
          label: 'OpenAI',
          authMode: 'api_key',
          model: 'gpt-4.1-mini',
          enabled: true,
          isDefault: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-04T00:00:00.000Z',
        },
      ],
      statuses: [],
      vendors: [
        {
          id: 'custom',
          name: 'Custom',
          supportedAuthModes: ['api_key'],
          defaultAuthMode: 'api_key',
          supportsMultipleAccounts: true,
        },
        {
          id: 'ollama',
          name: 'Ollama',
          supportedAuthModes: ['local'],
          defaultAuthMode: 'local',
          supportsMultipleAccounts: true,
        },
        {
          id: 'openai',
          name: 'OpenAI',
          defaultModelId: 'gpt-5.4',
          supportedAuthModes: ['api_key', 'oauth_browser'],
          defaultAuthMode: 'api_key',
          supportsMultipleAccounts: true,
        },
      ],
      defaultAccountId: 'openai-main',
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([
      {
        id: 'custom-12345678/gpt-4o-mini',
        provider: 'custom-12345678',
        providerLabel: 'Custom A',
        modelLabel: 'gpt-4o-mini',
        displayLabel: 'Custom A / gpt-4o-mini',
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: 'ollama-87654321/qwen3:latest',
        provider: 'ollama-87654321',
        providerLabel: 'Local Ollama',
        modelLabel: 'qwen3:latest',
        displayLabel: 'Local Ollama / qwen3:latest',
      },
      {
        id: 'ollama-87654321/llama3.1:8b',
        provider: 'ollama-87654321',
        providerLabel: 'Local Ollama',
        modelLabel: 'llama3.1:8b',
        displayLabel: 'Local Ollama / llama3.1:8b',
      },
      {
        id: 'openai/gpt-4.1-mini',
        provider: 'openai',
        providerLabel: 'OpenAI',
        modelLabel: 'gpt-4.1-mini',
        displayLabel: 'OpenAI / gpt-4.1-mini',
      },
    ]);
  });

  it('loadAvailableModels 优先复用 provider store 已就绪 snapshot', async () => {
    useProviderStore.setState({
      providerSnapshot: {
        accounts: [
          {
            id: 'openai-main',
            vendorId: 'openai',
            label: 'OpenAI',
            authMode: 'api_key',
            model: 'gpt-4.1-mini',
            enabled: true,
            isDefault: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        statuses: [],
        vendors: [
          {
            id: 'openai',
            name: 'OpenAI',
            defaultModelId: 'gpt-5.4',
            supportedAuthModes: ['api_key', 'oauth_browser'],
            defaultAuthMode: 'api_key',
            supportsMultipleAccounts: true,
          },
        ],
        defaultAccountId: 'openai-main',
      },
      snapshotReady: true,
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([
      {
        id: 'openai/gpt-4.1-mini',
        provider: 'openai',
        providerLabel: 'OpenAI',
        modelLabel: 'gpt-4.1-mini',
        displayLabel: 'OpenAI / gpt-4.1-mini',
      },
    ]);
    expect(hostApiFetchMock).not.toHaveBeenCalled();
  });

  it('loadAvailableModels 会映射 browser oauth runtime provider key', async () => {
    hostApiFetchMock.mockResolvedValue({
      accounts: [
        {
          id: 'openai-browser',
          vendorId: 'openai',
          label: 'OpenAI Browser',
          authMode: 'oauth_browser',
          model: 'gpt-5.4',
          enabled: true,
          isDefault: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      statuses: [],
      vendors: [
        {
          id: 'openai',
          name: 'OpenAI',
          defaultModelId: 'gpt-5.4',
          supportedAuthModes: ['api_key', 'oauth_browser'],
          defaultAuthMode: 'api_key',
          supportsMultipleAccounts: true,
        },
      ],
      defaultAccountId: 'openai-browser',
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([
      {
        id: 'openai-codex/gpt-5.4',
        provider: 'openai-codex',
        providerLabel: 'OpenAI Browser',
        modelLabel: 'gpt-5.4',
        displayLabel: 'OpenAI Browser / gpt-5.4',
      },
    ]);
  });

  it('provider snapshot 为空时，loadAvailableModels 返回空列表', async () => {
    hostApiFetchMock.mockResolvedValue({
      accounts: [],
      statuses: [],
      vendors: [],
      defaultAccountId: null,
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
  });

  it('loadAvailableModels 在 provider snapshot 失败时安全降级为空', async () => {
    hostApiFetchMock.mockRejectedValueOnce(new Error('provider snapshot failed'));

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
