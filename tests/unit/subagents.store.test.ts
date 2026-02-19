import { describe, expect, it, vi } from 'vitest';
import { useSubagentsStore } from '@/stores/subagents';

describe('subagents store', () => {
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

  it('hydrates workspace/model from config.get for edit form usage', async () => {
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

  it('loads configured models via config.get', async () => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockResolvedValueOnce({
      success: true,
      result: {
        baseHash: 'hash-models',
        config: {
          agents: {
            defaults: {
              model: {
                primary: 'openai/gpt-5',
                fallbacks: ['google/gemini-2.5-flash'],
              },
            },
            list: [
              { id: 'main', model: 'anthropic/claude-3-7-sonnet' },
              {
                id: 'writer',
                model: {
                  primary: 'openrouter/deepseek/v3',
                  fallbacks: ['openai/gpt-4.1-mini'],
                },
              },
            ],
          },
          models: {
            providers: {
              custom: {
                models: [{ id: 'gpt-4o-mini' }],
              },
              ollama: {
                models: [{ id: 'qwen3:latest' }],
              },
              siliconflow: {
                models: [{ id: 'deepseek-ai/DeepSeek-V3' }],
              },
            },
          },
        },
      },
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'config.get',
      {}
    );
    expect(useSubagentsStore.getState().availableModels).toEqual([
      { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic' },
      { id: 'custom/gpt-4o-mini', provider: 'custom' },
      { id: 'google/gemini-2.5-flash', provider: 'google' },
      { id: 'ollama/qwen3:latest', provider: 'ollama' },
      { id: 'openai/gpt-4.1-mini', provider: 'openai' },
      { id: 'openai/gpt-5', provider: 'openai' },
      { id: 'openrouter/deepseek/v3', provider: 'openrouter' },
      { id: 'siliconflow/deepseek-ai/DeepSeek-V3', provider: 'siliconflow' },
    ]);
  });

  it('returns empty model options when config has no model fields', async () => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockResolvedValueOnce({
      success: true,
      result: {
        baseHash: 'hash-empty',
        config: {
          agents: {
            list: [{ id: 'main' }],
          },
        },
      },
    });

    await useSubagentsStore.getState().loadAvailableModels();

    expect(useSubagentsStore.getState().availableModels).toEqual([]);
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
