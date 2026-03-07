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
  });

  it('hydrates workspace/model from config snapshot for edit form usage', async () => {
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
        identityEmoji: '⚙️',
      },
      {
        id: 'writer',
        name: 'Writer',
        workspace: '~/.openclaw/workspace-subagents/writer',
        model: 'openai/gpt-4.1-mini',
        isDefault: false,
        identityEmoji: '📊',
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

  it('reconcileAgentModels 按 defaults.primary/defaults.fallbacks/agents.list 顺序回填并写回配置', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          hash: 'hash-reconcile-multi',
          config: {
            agents: {
              defaults: {
                model: { primary: 'custom/removed-default' },
              },
              list: [
                { id: 'main', model: 'custom/removed-main-model' },
                { id: 'writer', model: 'anthropic/removed-writer-model' },
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
      })
      .mockResolvedValueOnce({
        success: true,
        result: { ok: true },
      });

    const changed = await useSubagentsStore.getState().reconcileAgentModels({
      removedModelIds: [
        'custom/removed-default',
        'custom/removed-main-model',
        'anthropic/removed-writer-model',
      ],
    });

    expect(changed).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'config.patch',
      {
        raw: JSON.stringify({
          agents: {
            defaults: { model: { primary: 'openai/gpt-4.1-mini' } },
            list: [
              { id: 'main', model: 'openai/gpt-4.1-mini' },
              { id: 'writer', model: 'openai/gpt-4.1-mini' },
            ],
          },
        }),
        baseHash: 'hash-reconcile-multi',
      },
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

  it('reconcileAgentModels 在仅有一个可用模型时会写回配置', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          hash: 'hash-reconcile-single',
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
      })
      .mockResolvedValueOnce({
        success: true,
        result: { ok: true },
      });

    const changed = await useSubagentsStore.getState().reconcileAgentModels({
      removedModelIds: ['custom/removed-main-model'],
    });

    expect(changed).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'config.patch',
      {
        raw: JSON.stringify({
          agents: {
            defaults: { model: { primary: 'openai/gpt-4.1-mini' } },
            list: [{ id: 'main', model: 'openai/gpt-4.1-mini' }],
          },
        }),
        baseHash: 'hash-reconcile-single',
      }
    );
  });

  it('reconcileAgentModels 保留 model 对象形态并仅替换 primary', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          hash: 'hash-reconcile-object-shape',
          config: {
            agents: {
              defaults: {
                model: {
                  primary: 'custom/removed-main-model',
                  fallbacks: ['openai/gpt-4.1-mini'],
                },
              },
              list: [
                {
                  id: 'main',
                  model: {
                    primary: 'custom/removed-main-model',
                    fallbacks: ['openai/gpt-4.1-mini'],
                  },
                },
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
      })
      .mockResolvedValueOnce({
        success: true,
        result: { ok: true },
      });

    const changed = await useSubagentsStore.getState().reconcileAgentModels({
      removedModelIds: ['custom/removed-main-model'],
    });

    expect(changed).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'config.patch',
      {
        raw: JSON.stringify({
          agents: {
            defaults: {
              model: {
                primary: 'openai/gpt-4.1-mini',
                fallbacks: ['openai/gpt-4.1-mini'],
              },
            },
            list: [
              {
                id: 'main',
                model: {
                  primary: 'openai/gpt-4.1-mini',
                  fallbacks: ['openai/gpt-4.1-mini'],
                },
              },
            ],
          },
        }),
        baseHash: 'hash-reconcile-object-shape',
      },
    );
  });

  it('reconcileAgentModels 传入预取配置时不再重复调用 config.get', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    const preloadedConfig = {
      hash: 'hash-reconcile-preloaded',
      config: {
        agents: {
          defaults: {
            model: { primary: 'custom/removed-main-model' },
          },
          list: [
            { id: 'main', model: 'custom/removed-main-model' },
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
    };

    invoke.mockResolvedValueOnce({
      success: true,
      result: { ok: true },
    });

    const changed = await useSubagentsStore.getState().reconcileAgentModels({
      removedModelIds: ['custom/removed-main-model'],
      cfg: preloadedConfig as ConfigGetResult,
    });

    expect(changed).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('gateway:rpc', 'config.get', {});
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'config.patch',
      {
        raw: JSON.stringify({
          agents: {
            defaults: { model: { primary: 'openai/gpt-4.1-mini' } },
            list: [{ id: 'main', model: 'openai/gpt-4.1-mini' }],
          },
        }),
        baseHash: 'hash-reconcile-preloaded',
      },
    );
  });

  it('reconcileAgentModels 在 removedModelIds 为空时直接 no-op', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);

    const changed = await useSubagentsStore.getState().reconcileAgentModels({
      removedModelIds: [],
    });

    expect(changed).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('gateway:rpc', 'config.get', {});
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

  it('hydrates identity emoji from agents.list.identity and agent.identity.get fallback', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          agents: [
            { id: 'main', name: 'Main', identity: { emoji: '⚙️' } },
            { id: 'writer', name: 'Writer' },
          ],
          defaultId: 'main',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          config: {
            agents: {
              list: [{ id: 'main', default: true }, { id: 'writer' }],
            },
          },
        },
      });

    invoke.mockImplementation(async (_channel, method, params) => {
      if (method === 'agent.identity.get') {
        const agentId = (params as { agentId?: string } | undefined)?.agentId ?? '';
        return {
          success: true,
          result: agentId === 'writer' ? { agentId, emoji: '📊' } : { agentId },
        };
      }
      return { success: false, error: `Unexpected method: ${String(method)}` };
    });

    await useSubagentsStore.getState().loadAgents();

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
