import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubagentsStore } from '@/stores/subagents';
import type { ConfigGetResult } from '@/types/subagent';

describe('subagents store', () => {
  beforeEach(() => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockReset();
    useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
  });

  it('loads agents.list via gateway rpc', async () => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockResolvedValueOnce({
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
    expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.list',
      {}
    );
  });

  it('loadAgents 会从配置快照补全 workspace/model 供编辑表单使用', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', identity: { emoji: '⚙️' } },
            { id: 'writer', name: 'Writer', identity: { emoji: '📊' } },
          ],
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          hash: 'hash-load',
          config: {
            agents: {
              defaults: {
                workspace: '~/.openclaw/workspace-main',
                model: { primary: 'openai/gpt-5' },
              },
              list: [
                {
                  id: 'writer',
                  workspace: '~/.openclaw/workspace-subagents/writer',
                  model: 'openai/gpt-4.1-mini',
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
        workspace: '~/.openclaw/workspace-main',
        model: 'openai/gpt-5',
        isDefault: true,
      },
      {
        id: 'writer',
        name: 'Writer',
        workspace: '~/.openclaw/workspace-subagents/writer',
        model: 'openai/gpt-4.1-mini',
        isDefault: false,
      },
    ]);
  });

  it('loadAvailableModels 读取 config 快照中的 providers.models', async () => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockResolvedValueOnce({
      success: true,
      result: {
        config: {
          models: {
            providers: {
              custom: {
                models: [{ id: 'gpt-4o-mini', name: 'GPT-4o Mini' }],
              },
              ollama: {
                models: [{ id: 'qwen3:latest', name: 'Qwen3 Latest' }],
              },
            },
          },
        },
      },
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'openclaw:getConfigJson'
    );
    expect(useSubagentsStore.getState().availableModels).toEqual([
      { id: 'custom/gpt-4o-mini', provider: 'custom' },
      { id: 'ollama/qwen3:latest', provider: 'ollama' },
    ]);
  });

  it('loadAvailableModels 传入预取配置时不再重复调用 config.get', async () => {
    const preloadedConfig = {
      config: {
        models: {
          providers: {
            custom: {
              models: [{ id: 'gpt-4o-mini', name: 'GPT-4o Mini' }],
            },
          },
        },
      },
    };

    await useSubagentsStore.getState().loadAvailableModels(preloadedConfig as ConfigGetResult);

    expect(window.electron.ipcRenderer.invoke).not.toHaveBeenCalledWith(
      'gateway:rpc',
      'config.get',
      {}
    );
    expect(useSubagentsStore.getState().availableModels).toEqual([
      { id: 'custom/gpt-4o-mini', provider: 'custom' },
    ]);
  });

  it('returns empty model options when config has no providers.models', async () => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockResolvedValueOnce({
      success: true,
      result: {
        config: {
          models: {
            providers: {},
          },
        },
      },
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
  });

  it('loadAvailableModels 合并 agents.defaults.models 中的模型', async () => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockResolvedValueOnce({
      success: true,
      result: {
        config: {
          agents: {
            defaults: {
              models: {
                'local/claude-sonnet-4.5': {},
              },
            },
          },
          models: {
            providers: {},
          },
        },
      },
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([
      { id: 'local/claude-sonnet-4.5', provider: 'local' },
    ]);
  });

  it('loadAgents 仅按配置模型显示，不做运行时回填', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', model: 'custom/removed-main-model', identity: { emoji: '⚙️' } },
            { id: 'writer', name: 'Writer', model: 'openai/gpt-4.1-mini', identity: { emoji: '📊' } },
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
    expect(invoke).not.toHaveBeenCalledWith('gateway:rpc', 'config.patch', expect.anything());
  });

  it('loadAgents 在多模型场景下仍保持配置模型值', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', model: 'custom/removed-main-model', identity: { emoji: '⚙️' } },
            { id: 'writer', name: 'Writer', model: 'openai/gpt-4.1-mini', identity: { emoji: '📊' } },
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
    expect(invoke).not.toHaveBeenCalledWith('gateway:rpc', 'config.patch', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.update',
      expect.anything(),
    );
  });

  it('loadAgents 不应用 defaults.model.fallbacks 的运行时回填', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', model: 'custom/removed-main-model', identity: { emoji: '⚙️' } },
            { id: 'writer', name: 'Writer', model: 'openai/gpt-4.1-mini', identity: { emoji: '📊' } },
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
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', model: 'openai/gpt-4.1-mini', identity: { emoji: '⚙️' } },
            { id: 'writer', name: 'Writer', model: 'anthropic/claude-3-7-sonnet', identity: { emoji: '📊' } },
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
    expect(invoke).not.toHaveBeenCalledWith('gateway:rpc', 'config.patch', expect.anything());
  });

  it('loadAgents 不依赖运行时模型目录', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
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
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', identity: { emoji: '⚙️' } },
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
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
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
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [{ id: 'main', name: 'Main', identity: { emoji: '⚙️' } }],
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
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, method) => {
      if (channel === 'gateway:rpc' && method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [{ id: 'main', name: 'Main', identity: { emoji: '⚙️' } }],
            defaultId: 'main',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      if (channel === 'openclaw:getConfigJson') {
        return {
          config: {
            agents: {
              list: [
                { id: 'main', name: 'Main' },
                { id: 'ghost-delete-001', name: 'ghost-delete-001', model: 'local/claude-sonnet-4.5' },
              ],
            },
          },
        };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
    });

    await useSubagentsStore.getState().loadAgents();

    const agents = useSubagentsStore.getState().agents;
    expect(agents.map((item) => item.id)).toEqual(['main']);
  });

  it('loadAgents 默认模型/工作区补全只作用于 defaultAgentId，不写死 main', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
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
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          config: {
            agents: {
              defaults: {
                workspace: '/workspace/default',
                model: { primary: 'openai/gpt-4.1-mini' },
              },
              list: [
                { id: 'main', name: 'Main' },
                { id: 'dev', name: 'Dev' },
              ],
            },
          },
        },
      });

    await useSubagentsStore.getState().loadAgents();

    const agents = useSubagentsStore.getState().agents;
    const dev = agents.find((item) => item.id === 'dev');
    const main = agents.find((item) => item.id === 'main');
    expect(dev).toMatchObject({
      id: 'dev',
      workspace: '/workspace/default',
      model: 'openai/gpt-4.1-mini',
      isDefault: true,
    });
    expect(main).toMatchObject({
      id: 'main',
      workspace: undefined,
      model: undefined,
      isDefault: false,
    });
  });

  it('loadAgents 并发请求时，仅最后一次结果可以落库', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    let resolveFirstList: ((value: unknown) => void) | null = null;
    const firstListPromise = new Promise((resolve) => {
      resolveFirstList = resolve;
    });
    let agentsListCallCount = 0;

    invoke.mockImplementation(async (channel, method) => {
      if (channel === 'gateway:rpc' && method === 'agents.list') {
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
      if (channel === 'openclaw:getConfigJson') {
        return {
          config: {
            agents: {
              defaults: {
                model: { primary: 'openai/gpt-4.1-mini' },
              },
            },
          },
        };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
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
    expect(useSubagentsStore.getState().loading).toBe(false);
  });

  it('loadAgents 会先用 agents.list.identity，再回退 agent.identity.get 补齐 emoji', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, method, params) => {
      if (channel === 'gateway:rpc' && method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [
              { id: 'main', name: 'Main', identity: { emoji: '⚙️' } },
              { id: 'writer', name: 'Writer' },
            ],
            defaultId: 'main',
          },
        };
      }
      if (channel === 'openclaw:getConfigJson') {
        return {
          config: {
            agents: {
              list: [{ id: 'main', default: true }, { id: 'writer' }],
            },
          },
        };
      }
      if (channel === 'gateway:rpc' && method === 'agent.identity.get') {
        const agentId = (params as { agentId?: string } | undefined)?.agentId ?? '';
        return {
          success: true,
          result: agentId === 'writer' ? { agentId, emoji: '📊' } : { agentId },
        };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
    });

    await useSubagentsStore.getState().loadAgents();

    await vi.waitFor(() => {
      const agents = useSubagentsStore.getState().agents;
      expect(agents).toHaveLength(2);
      expect(agents[0]).toMatchObject({
        id: 'main',
        name: 'Main',
        isDefault: true,
        identityEmoji: '⚙️',
      });
      expect(agents[1]).toMatchObject({
        id: 'writer',
        name: 'Writer',
        isDefault: false,
        identityEmoji: '📊',
      });
    });
  });

  it('deleteAgent 后，晚到的 identity hydrate 不会把已删 agent 回写到列表', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    let resolveGhostIdentity: ((value: unknown) => void) | null = null;
    const ghostIdentityPromise = new Promise((resolve) => {
      resolveGhostIdentity = resolve;
    });

    invoke.mockImplementation(async (channel, method, params) => {
      if (channel === 'gateway:rpc' && method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [
              { id: 'main', name: 'Main', identity: { emoji: '⚙️' } },
              { id: 'ghost-delete-002', name: 'ghost-delete-002' },
            ],
            defaultId: 'main',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      if (channel === 'openclaw:getConfigJson') {
        return {
          success: true,
          result: {
            config: {
              agents: {
                list: [
                  { id: 'main', name: 'Main' },
                  { id: 'ghost-delete-002', name: 'ghost-delete-002', model: 'local/claude-sonnet-4.5' },
                ],
              },
            },
          },
        };
      }
      if (channel === 'gateway:rpc' && method === 'agent.identity.get') {
        const agentId = (params as { agentId?: string } | undefined)?.agentId ?? '';
        if (agentId === 'ghost-delete-002') {
          return ghostIdentityPromise;
        }
        return { success: true, result: { agentId } };
      }
      if (channel === 'gateway:rpc' && method === 'agents.delete') {
        return { success: true, result: { ok: true } };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
    });

    await useSubagentsStore.getState().loadAgents();
    expect(useSubagentsStore.getState().agents.map((agent) => agent.id)).toEqual(['main', 'ghost-delete-002']);

    await useSubagentsStore.getState().deleteAgent('ghost-delete-002');
    expect(useSubagentsStore.getState().agents.map((agent) => agent.id)).toEqual(['main']);

    resolveGhostIdentity?.({
      success: true,
      result: {
        agentId: 'ghost-delete-002',
        emoji: '🏁',
      },
    });

    await vi.waitFor(() => {
      expect(useSubagentsStore.getState().agents.map((agent) => agent.id)).toEqual(['main']);
    });
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
          identity: { emoji: '⚙️' },
        },
        {
          id: 'ghost-delete-003',
          name: 'ghost-delete-003',
          workspace: '/workspace/ghost-delete-003',
          model: 'local/claude-sonnet-4.5',
          isDefault: false,
          identity: { emoji: '🏁' },
        },
      ],
    });

    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, method, params) => {
      if (channel === 'gateway:rpc' && method === 'agents.delete') {
        expect(params).toEqual({ agentId: 'ghost-delete-003', deleteFiles: true });
        return { success: true, result: { ok: true } };
      }
      if (channel === 'gateway:rpc' && method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [
              { id: 'main', name: 'Main', identity: { emoji: '⚙️' } },
              { id: 'ghost-delete-003', name: 'ghost-delete-003', identity: { emoji: '🏁' } },
            ],
            defaultId: 'main',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      if (channel === 'openclaw:getConfigJson') {
        return {
          success: true,
          result: {
            config: {
              agents: {
                list: [
                  { id: 'main', name: 'Main' },
                  { id: 'ghost-delete-003', name: 'ghost-delete-003', model: 'local/claude-sonnet-4.5' },
                ],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected invoke call: ${String(channel)} ${String(method)}`);
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
          identity: { emoji: '⚙️' },
        },
        {
          id: 'ghost-delete-001',
          name: 'ghost-delete-001',
          workspace: '/workspace/ghost-delete-001',
          model: 'local/claude-sonnet-4.5',
          isDefault: false,
          identity: { emoji: '🏁' },
        },
      ],
    });

    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel: string, method: unknown, params: unknown) => {
      if (channel === 'gateway:rpc' && method === 'agents.delete') {
        expect(params).toEqual({ agentId: 'ghost-delete-001', deleteFiles: true });
        return { success: true, result: { ok: true } };
      }
      throw new Error(`Unexpected invoke call: ${channel} ${String(method)}`);
    });

    await useSubagentsStore.getState().deleteAgent('ghost-delete-001');

    const agents = useSubagentsStore.getState().agents;
    expect(agents.map((item) => item.id)).toEqual(['main']);
    expect(invoke).not.toHaveBeenCalledWith('gateway:rpc', 'agents.list', {});
  });
});
