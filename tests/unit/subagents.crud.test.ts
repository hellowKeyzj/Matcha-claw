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
    invoke
      .mockResolvedValueOnce({ success: true, result: {} })
      .mockResolvedValueOnce({ success: true, result: {} });

    await useSubagentsStore.getState().createAgent({
      name: 'writer',
      workspace: '/tmp/writer',
      model: 'gpt-4.1-mini',
    });

    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.create',
      { name: 'writer', workspace: '/home/dev/.openclaw/workspace-subagents/writer' }
    );
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.update',
      { agentId: 'writer', model: 'gpt-4.1-mini' }
    );
  });

  it('passes emoji to agents.create when provided', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({ success: true, result: {} })
      .mockResolvedValueOnce({ success: true, result: {} });

    await useSubagentsStore.getState().createAgent({
      name: 'writer',
      workspace: '/tmp/writer',
      model: 'gpt-4.1-mini',
      emoji: '🤖',
    });

    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.create',
      { name: 'writer', workspace: '/home/dev/.openclaw/workspace-subagents/writer', emoji: '🤖' }
    );
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
