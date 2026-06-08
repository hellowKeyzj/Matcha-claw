import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { SubAgents } from '@/pages/SubAgents';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';
import { __resetSubagentTemplateCatalogCacheForTest } from '@/services/openclaw/subagent-template-catalog';
import type { AgentScope, RuntimeEndpointRef, RuntimeScope } from '../../runtime-host/shared/runtime-address';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="router-location">{`${location.pathname}${location.search}`}</div>;
}

const runtimeEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};
const defaultAgentScope: AgentScope = {
  kind: 'agent',
  endpoint: runtimeEndpoint,
  agentId: 'default',
};
const workspaceScope: RuntimeScope = {
  kind: 'workspace',
  endpoint: runtimeEndpoint,
};

function buildCapabilitiesListEnvelope() {
  return {
    ok: true,
    data: {
      status: 200,
      ok: true,
      json: {
        capabilities: [
          {
            id: 'subagent.management',
            kind: 'subagent.management',
            scopeKind: 'agent',
            scope: defaultAgentScope,
            targetKinds: ['subagent'],
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
            targetAgentIds: ['default'],
            supportLevel: 'native',
            availability: 'available',
            operations: [],
            policyScope: 'subagent.management',
            ownerModuleId: 'openclaw',
            routeOwnerId: 'openclaw',
          },
          {
            id: 'model.provider',
            kind: 'model.provider',
            scopeKind: 'agent',
            scope: defaultAgentScope,
            targetKinds: ['model-selection'],
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
            targetAgentIds: ['default'],
            supportLevel: 'native',
            availability: 'available',
            operations: [],
            policyScope: 'model.provider',
            ownerModuleId: 'openclaw',
            routeOwnerId: 'openclaw',
          },
          {
            id: 'workspace.file',
            kind: 'workspace.file',
            scopeKind: 'workspace',
            scope: workspaceScope,
            targetKinds: ['workspace-file'],
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
            targetAgentIds: ['default'],
            supportLevel: 'native',
            availability: 'available',
            operations: [],
            policyScope: 'workspace.file',
            ownerModuleId: 'openclaw',
            routeOwnerId: 'openclaw',
          },
        ],
      },
    },
  };
}

function renderSubagentsPage(initialEntries: string[] = ['/subagents']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <SubAgents />
    </MemoryRouter>,
  );
}

async function openCreateDialog(): Promise<void> {
  const button = await screen.findByRole('button', { name: 'New Subagent' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

async function openEditDialog(agentId: string): Promise<void> {
  const button = await screen.findByRole('button', { name: `Edit ${agentId}` });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('subagents page', () => {
  const createAgent = vi.fn().mockResolvedValue({ agentId: 'writer' });
  const createAgentFromTemplate = vi.fn().mockResolvedValue({ agentId: 'brand-guardian' });
  const updateAgent = vi.fn().mockResolvedValue(undefined);
  const deleteAgent = vi.fn().mockResolvedValue(undefined);
  const exportAgentConfig = vi.fn().mockResolvedValue({
    schema: 'matchaclaw.agent-config',
    version: 1,
    agent: {
      name: 'Alpha',
      skills: ['web-search'],
      skillBundles: [
        {
          skillKey: 'web-search',
          files: [{ path: 'SKILL.md', content: 'web skill' }],
        },
      ],
      files: {},
    },
  });
  const importAgentConfig = vi.fn().mockResolvedValue({ agentId: 'imported-agent' });
  const loadAgents = vi.fn().mockResolvedValue(undefined);
  const loadAvailableModels = vi.fn().mockResolvedValue(undefined);
  const generateDraftFromPrompt = vi.fn().mockResolvedValue(undefined);
  const cancelDraft = vi.fn().mockResolvedValue(undefined);
  const loadPersistedFilesForAgent = vi.fn().mockResolvedValue({});

  beforeEach(() => {
    __resetSubagentTemplateCatalogCacheForTest();
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockReset();
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [],
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/workspace-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: '/home/dev/.openclaw/workspace',
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/config-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: '/home/dev/.openclaw',
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      return undefined;
    });
    createAgent.mockClear();
    createAgentFromTemplate.mockClear();
    updateAgent.mockClear();
    deleteAgent.mockClear();
    exportAgentConfig.mockClear();
    importAgentConfig.mockClear();
    loadAgents.mockClear();
    loadAvailableModels.mockClear();
    generateDraftFromPrompt.mockClear();
    cancelDraft.mockClear();
    loadPersistedFilesForAgent.mockClear();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.warning).mockReset();
    vi.mocked(toast.error).mockReset();

    i18n.changeLanguage('en');
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
      health: null,
      isInitialized: true,
      lastError: null,
    });
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/home/dev/.openclaw/workspace',
          model: 'gpt-main',
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
          isDefault: true,
        },
        {
          id: 'agent-alpha',
          name: 'Alpha',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'gpt-4o-mini',
          avatarSeed: 'agent:agent-alpha',
          avatarStyle: 'bottts',
          isDefault: false,
        },
      ],
      availableModels: [
        {
          id: 'gpt-4.1-mini',
          provider: 'openai',
          providerLabel: 'OpenAI',
          modelLabel: 'gpt-4.1-mini',
          displayLabel: 'OpenAI / gpt-4.1-mini',
        },
        {
          id: 'claude-3-7-sonnet',
          provider: 'anthropic',
          providerLabel: 'Anthropic',
          modelLabel: 'claude-3-7-sonnet',
          displayLabel: 'Anthropic / claude-3-7-sonnet',
        },
      ],
      modelsLoading: false,
      agentsResource: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      mutating: false,
      error: null,
      managedAgentId: null,
      draftPromptByAgent: {},
      draftGeneratingByAgent: {},
      draftApplyingByAgent: {},
      draftApplySuccessByAgent: {},
      draftIncludeCurrentFilesByAgent: {},
      persistedFilesByAgent: {
        'agent-alpha': {
          'AGENTS.md': 'saved agents',
          'SOUL.md': 'saved soul',
          'TOOLS.md': 'saved tools',
          'IDENTITY.md': 'saved identity',
          'USER.md': 'saved user',
        },
      },
      draftByFile: {},
      draftError: null,
      previewDiffByFile: {},
      selectedAgentId: null,
      loadAgents,
      loadAvailableModels,
      loadPersistedFilesForAgent,
      selectAgent: vi.fn(),
      createAgent,
      createAgentFromTemplate,
      updateAgent,
      deleteAgent,
      exportAgentConfig,
      importAgentConfig,
      generateDraftFromPrompt,
      cancelDraft,
    });
  });

  it('renders agents in a card grid', () => {
    renderSubagentsPage();

    expect(screen.getByTestId('subagent-card-grid')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('agent-alpha')).toBeInTheDocument();
    expect(screen.getByText('gpt-main')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByTestId('agent-avatar-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-avatar-agent-alpha')).toBeInTheDocument();
  });

  it('挂载时等待网关 ready 后再加载模型和 agents', () => {
    useGatewayStore.setState({
      status: {
        processState: 'stopped',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
    });
    useSubagentsStore.setState({
      agents: [],
      availableModels: [],
    });
    renderSubagentsPage();
    expect(loadAgents).not.toHaveBeenCalled();
    expect(loadAvailableModels).not.toHaveBeenCalled();
  });

  it('网关恢复到 running 后会自动重载数据', async () => {
    useGatewayStore.setState({
      status: {
        processState: 'stopped',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
    });
    renderSubagentsPage();
    expect(loadAgents).not.toHaveBeenCalled();
    expect(loadAvailableModels).not.toHaveBeenCalled();

    act(() => {
      useGatewayStore.setState({
        status: {
          processState: 'running',
          port: 18789,
          gatewayReady: true,
          healthSummary: 'healthy',
          transportState: 'connected',
          portReachable: true,
          diagnostics: {
            consecutiveHeartbeatMisses: 0,
            consecutiveRpcFailures: 0,
          },
          updatedAt: 2,
        },
      });
    });

    await waitFor(() => {
      expect(loadAgents).toHaveBeenCalledTimes(1);
    });
    expect(loadAvailableModels).toHaveBeenCalledTimes(1);
  });

  it('shows top guide when there is no available model', () => {
    useSubagentsStore.setState({
      availableModels: [],
      modelsLoading: false,
    });

    renderSubagentsPage(['/subagents']);

    expect(screen.getByText('Please go to Models to add a model first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Models' }));
    expect(screen.getByTestId('router-location')).toHaveTextContent('/providers');
  });

  it('opens create dialog when clicking add button', async () => {
    renderSubagentsPage();

    await openCreateDialog();

    expect(screen.getByRole('dialog', { name: 'Create Subagent' })).toBeInTheDocument();
  });

  it('submits create form and calls createAgent', async () => {
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    expect(screen.getByLabelText('Workspace')).toHaveValue(
      '/home/dev/.openclaw/workspace-subagents/writer'
    );
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-4.1-mini');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: 'gpt-4.1-mini',
        avatarSeed: expect.any(String),
        avatarStyle: 'pixelArt',
      }));
    });
  });

  it('createAgent 失败时保持弹窗打开，不进入管理态', async () => {
    createAgent.mockRejectedValueOnce(new Error('RPC timeout: agents.create'));
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: 'gpt-4.1-mini',
        avatarSeed: expect.any(String),
        avatarStyle: 'pixelArt',
      }));
    });

    expect(screen.getByRole('dialog', { name: 'Create Subagent' })).toBeInTheDocument();
    expect(screen.queryByText('Managing: writer')).toBeNull();
  });

  it('create dialog no longer renders emoji input', async () => {
    renderSubagentsPage();

    await openCreateDialog();

    expect(screen.queryByLabelText('Emoji')).toBeNull();
    expect(screen.getByText('Avatar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'avatar-style-pixelArt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'avatar-style-bottts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'avatar-style-botttsNeutral' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('supports selecting an avatar option and avatar style when creating subagent', async () => {
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'avatar-style-bottts' }));
    const avatarButtons = screen.getAllByRole('button', { name: /pick-avatar-/ });
    fireEvent.click(avatarButtons[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: 'gpt-4.1-mini',
        avatarSeed: expect.stringContaining('picker:writer'),
        avatarStyle: 'bottts',
      }));
    });
  });

  it('prefills manage prompt from create dialog initial prompt', async () => {
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.change(screen.getByLabelText('System Prompt'), {
      target: { value: 'act as a finance analyst' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: 'gpt-4.1-mini',
        avatarSeed: expect.any(String),
        avatarStyle: 'pixelArt',
      }));
    });

    expect(screen.getByText('Managing: writer')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('act as a finance analyst');
  });

  it('create 返回 warning 时仍进入管理态，并显示 warning toast', async () => {
    createAgent.mockResolvedValueOnce({
      agentId: 'writer',
      warning: '智能体 "writer" 已创建，但模型配置写入失败：RPC timeout: agents.update。请在编辑中重新确认',
    });
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: 'gpt-4.1-mini',
      }));
    });

    await waitFor(() => {
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      '智能体 "writer" 已创建，但模型配置写入失败：RPC timeout: agents.update。请在编辑中重新确认',
    );
    });
    expect(screen.getByText('Managing: writer')).toBeInTheDocument();
  });

  it('opens detail view when clicking manage button', () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'Manage agent-alpha' }));

    expect(loadPersistedFilesForAgent).toHaveBeenCalledWith('agent-alpha');
    expect(screen.getByText('Managing: agent-alpha')).toBeInTheDocument();
  });

  it('submits prompt to generate subagent draft', async () => {
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
    });
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'Manage agent-alpha' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'draft policy docs' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate Draft' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Draft' }));

    await waitFor(() => {
      expect(generateDraftFromPrompt).toHaveBeenCalledWith({
        agentId: 'agent-alpha',
        prompt: 'draft policy docs',
        includeCurrentFiles: false,
      });
    });
  });

  it('passes current-file baseline option when draft switch is enabled', async () => {
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
    });
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'Manage agent-alpha' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'draft policy docs' } });
    fireEvent.click(screen.getByRole('switch', { name: /Use current files/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate Draft' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Draft' }));

    await waitFor(() => {
      expect(generateDraftFromPrompt).toHaveBeenCalledWith({
        agentId: 'agent-alpha',
        prompt: 'draft policy docs',
        includeCurrentFiles: true,
      });
    });
  });

  it('does not show applying label while only generating draft', () => {
    useSubagentsStore.setState({
      managedAgentId: 'agent-alpha',
      draftGeneratingByAgent: { 'agent-alpha': true },
      draftApplyingByAgent: { 'agent-alpha': false },
      draftByFile: {
        'AGENTS.md': {
          name: 'AGENTS.md',
          content: 'content',
          reason: 'reason',
          confidence: 0.9,
          needsReview: false,
        },
      },
      previewDiffByFile: {},
      draftError: null,
    });

    renderSubagentsPage();

    expect(screen.getByRole('button', { name: 'Generating...' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Apply Draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Applying...' })).toBeNull();
  });

  it('calls edit/delete actions for non-main agent', async () => {
    renderSubagentsPage();

    await openEditDialog('agent-alpha');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha v2' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-3-7-sonnet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete agent-alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete agent-alpha' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledWith({
        agentId: 'agent-alpha',
        name: 'Alpha v2',
        workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
        model: 'claude-3-7-sonnet',
      });
    });
    expect(deleteAgent).toHaveBeenCalledWith('agent-alpha');
  });

  it('exports selected agent config to a picked json path', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'dialog:save') {
        return { canceled: false, filePath: '/tmp/alpha.matchaclaw-agent.json' };
      }
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/execute') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: { ok: true, path: '/tmp/alpha.matchaclaw-agent.json' },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [],
            },
          },
        };
      }
      return undefined;
    });
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
    });
    renderSubagentsPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Export agent-alpha' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Export agent-alpha' }));

    await waitFor(() => {
      expect(exportAgentConfig).toHaveBeenCalledWith('agent-alpha');
    });
    const writeCall = invoke.mock.calls.find(([channel]) => channel === 'dialog:writeSelectedTextFile');
    expect(writeCall).toBeTruthy();
    expect(writeCall?.[1]).toEqual(expect.objectContaining({
      defaultPath: expect.stringContaining('alpha.matchaclaw-agent.json'),
    }));
    expect(JSON.parse(String(writeCall?.[2] ?? '{}'))).toEqual(expect.objectContaining({
      schema: 'matchaclaw.agent-config',
      version: 1,
    }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Agent config exported.');
    });
  });

  it('imports agent config from a picked json file', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'dialog:readSelectedTextFile') {
        return {
          canceled: false,
          filePath: '/tmp/shared.matchaclaw-agent.json',
          content: JSON.stringify({
            schema: 'matchaclaw.agent-config',
            version: 1,
            agent: {
              name: 'Shared Agent',
              files: {
                'AGENTS.md': 'shared agents',
              },
            },
          }),
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [],
            },
          },
        };
      }
      return undefined;
    });
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
    });
    renderSubagentsPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Import Agent' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import Agent' }));

    await waitFor(() => {
      expect(importAgentConfig).toHaveBeenCalledWith(expect.objectContaining({
        schema: 'matchaclaw.agent-config',
        version: 1,
      }));
    });
    expect(loadPersistedFilesForAgent).toHaveBeenCalledWith('imported-agent');
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Agent config imported.');
    });
  });

  it('edit dialog no longer renders skill configuration section', async () => {
    renderSubagentsPage();

    await openEditDialog('agent-alpha');
    expect(screen.queryByText('Skill Configuration')).toBeNull();
    expect(screen.queryByText('Web Search')).toBeNull();
    expect(screen.queryByText('Feishu Doc')).toBeNull();
  });

  it('编辑时不应把已删除模型补回下拉选项，并在单模型场景自动回填', async () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/home/dev/.openclaw/workspace',
          model: 'gpt-main',
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
          isDefault: true,
        },
        {
          id: 'agent-alpha',
          name: 'Alpha',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'legacy/removed-model',
          avatarSeed: 'agent:agent-alpha',
          avatarStyle: 'bottts',
          isDefault: false,
        },
      ],
      availableModels: [
        {
          id: 'openai/gpt-4.1-mini',
          provider: 'openai',
          providerLabel: 'OpenAI',
          modelLabel: 'gpt-4.1-mini',
          displayLabel: 'OpenAI / gpt-4.1-mini',
        },
      ],
      modelsLoading: false,
    });

    renderSubagentsPage();
    await openEditDialog('agent-alpha');

    const modelSelect = screen.getByLabelText('Model');
    expect(screen.queryByRole('option', { name: 'legacy/removed-model' })).toBeNull();
    expect(modelSelect).toHaveValue('openai/gpt-4.1-mini');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('编辑子 Agent 时模型下拉优先显示 provider 自定义名称', async () => {
    useSubagentsStore.setState({
      availableModels: [
        {
          id: 'custom-dd749b2e/gpt-4o-mini',
          provider: 'custom-dd749b2e',
          credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          providerLabel: '自定义',
          modelLabel: 'gpt-4o-mini',
          displayLabel: '自定义 / gpt-4o-mini',
        },
      ],
      modelsLoading: false,
    });

    renderSubagentsPage();
    await openEditDialog('agent-alpha');

    expect(
      screen.getByRole('option', { name: '自定义 / gpt-4o-mini' })
    ).toBeInTheDocument();
  });

  it('Agent 卡片优先显示统一模型展示文案，找不到映射时回退原始模型 id', () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/home/dev/.openclaw/workspace',
          model: 'custom-dd749b2e/gpt-4o-mini',
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
          isDefault: true,
        },
        {
          id: 'agent-alpha',
          name: 'Alpha',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'legacy/removed-model',
          avatarSeed: 'agent:agent-alpha',
          avatarStyle: 'bottts',
          isDefault: false,
        },
      ],
      availableModels: [
        {
          id: 'custom-dd749b2e/gpt-4o-mini',
          provider: 'custom-dd749b2e',
          credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          providerLabel: '前端专家',
          modelLabel: 'gpt-4o-mini',
          displayLabel: '前端专家 / gpt-4o-mini',
        },
      ],
    });

    renderSubagentsPage();

    expect(screen.getByText('前端专家 / gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText('legacy/removed-model')).toBeInTheDocument();
  });

  it('模板加载弹窗里的模型下拉也使用统一展示文案', async () => {
    useSubagentsStore.setState({
      availableModels: [
        {
          id: 'custom-dd749b2e/gpt-4o-mini',
          provider: 'custom-dd749b2e',
          credentialId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          providerLabel: '前端专家',
          modelLabel: 'gpt-4o-mini',
          displayLabel: '前端专家 / gpt-4o-mini',
        },
      ],
      modelsLoading: false,
    });

    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [
                {
                  id: 'brand-guardian',
                  name: 'Brand Guardian',
                  summary: 'Brand guard template',
                  files: ['AGENTS.md'],
                },
              ],
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates/brand-guardian') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              template: {
                id: 'brand-guardian',
                name: 'Brand Guardian',
                summary: 'Brand guard template',
                files: ['AGENTS.md'],
                fileContents: {
                  'AGENTS.md': 'agents',
                },
              },
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/workspace-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: '/home/dev/.openclaw/workspace',
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/config-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: '/home/dev/.openclaw',
          },
        };
      }
      return undefined;
    });

    renderSubagentsPage();

    const expandTemplatesButton = await screen.findByRole('button', { name: 'Expand Template Library' });
    fireEvent.click(expandTemplatesButton);
    const loadTemplateButton = await screen.findByRole('button', { name: 'Load Template' });
    await waitFor(() => expect(loadTemplateButton).toBeEnabled());
    fireEvent.click(loadTemplateButton);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Load Template: Brand Guardian' })).toBeInTheDocument();
    });

    expect(
      screen.getByRole('option', { name: '前端专家 / gpt-4o-mini' })
    ).toBeInTheDocument();
  });

  it('does not render set-default action buttons', () => {
    renderSubagentsPage();

    expect(screen.queryByRole('button', { name: 'Set default main' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set default agent-alpha' })).toBeNull();
  });

  it('blocks create when name conflicts with existing slug', async () => {
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'agent alpha' } });

    expect(screen.getByText('Agent name is duplicated.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('keeps main manageable but blocks delete for protected default agent', () => {
    renderSubagentsPage();

    expect(screen.getByRole('button', { name: 'Edit main' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete main' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Manage main' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Chat main' })).toBeEnabled();
  });

  it('disables manage/chat actions when model is missing', () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/home/dev/.openclaw/workspace',
          model: 'gpt-main',
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
          isDefault: true,
        },
        {
          id: 'agent-no-model',
          name: 'NoModel',
          workspace: '/home/dev/.openclaw/workspace-subagents/no-model',
          model: undefined,
          avatarSeed: 'agent:agent-no-model',
          avatarStyle: 'botttsNeutral',
          isDefault: false,
        },
      ],
    });

    renderSubagentsPage();

    expect(screen.getByRole('button', { name: 'Manage agent-no-model' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Chat agent-no-model' })).toBeDisabled();
  });

  it('keeps managed panel visible after page remount', () => {
    const { unmount } = renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'Manage agent-alpha' }));
    expect(screen.getByText('Managing: agent-alpha')).toBeInTheDocument();

    unmount();
    renderSubagentsPage();

    expect(screen.getByText('Managing: agent-alpha')).toBeInTheDocument();
  });

  it('shows apply success feedback and hides apply buttons when draft is cleared', () => {
    useSubagentsStore.setState({
      managedAgentId: 'agent-alpha',
      draftApplySuccessByAgent: { 'agent-alpha': true },
      draftByFile: {},
      previewDiffByFile: {},
      draftError: null,
    });

    renderSubagentsPage();

    expect(screen.getByText('Draft applied successfully.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate Diff Preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm Apply Draft' })).toBeNull();
  });

  it('closes manage dialog via top-right close button and triggers cancel action', async () => {
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
    });
    useSubagentsStore.setState({
      managedAgentId: 'agent-alpha',
      draftByFile: {
        'AGENTS.md': {
          name: 'AGENTS.md',
          content: 'content',
          reason: 'reason',
          confidence: 0.9,
          needsReview: false,
        },
      },
      previewDiffByFile: {},
    });

    renderSubagentsPage();

    expect(await screen.findByRole('dialog', { name: 'Managing: agent-alpha' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(cancelDraft).toHaveBeenCalledWith('agent-alpha');
    });
    expect(screen.queryByRole('dialog', { name: 'Managing: agent-alpha' })).toBeNull();
  });

  it('navigates to chat with selected agent when clicking chat button', () => {
    renderSubagentsPage(['/subagents']);

    fireEvent.click(screen.getByRole('button', { name: 'Chat agent-alpha' }));

    expect(screen.getByTestId('router-location')).toHaveTextContent('/?agent=agent-alpha');
  });

  it('loads a template and creates subagent with template defaults', async () => {
    useSubagentsStore.setState({
      availableModels: [
        {
          id: 'gpt-4.1-mini',
          provider: 'openai',
          providerLabel: 'OpenAI',
          modelLabel: 'gpt-4.1-mini',
          displayLabel: 'OpenAI / gpt-4.1-mini',
        },
      ],
      modelsLoading: false,
    });
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [
                {
                  id: 'brand-guardian',
                  name: 'Brand Guardian',
                  summary: 'Brand guard template',
                  files: ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md'],
                },
              ],
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates/brand-guardian') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              template: {
                id: 'brand-guardian',
                name: 'Brand Guardian',
                summary: 'Brand guard template',
                files: ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md'],
                fileContents: {
                  'AGENTS.md': 'agents',
                  'SOUL.md': 'soul',
                  'TOOLS.md': 'tools',
                  'IDENTITY.md': 'identity',
                  'USER.md': 'user',
                },
              },
            },
          },
        };
      }
      return undefined;
    });

    renderSubagentsPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Expand Template Library' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Template Library' }));
    const loadTemplateButton = await screen.findByRole('button', { name: 'Load Template' });
    await waitFor(() => expect(loadTemplateButton).toBeEnabled());
    fireEvent.click(loadTemplateButton);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Load Template: Brand Guardian' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    await waitFor(() => {
      expect(createAgentFromTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4.1-mini',
          template: expect.objectContaining({
            id: 'brand-guardian',
            name: 'Brand Guardian',
          }),
        }),
      );
    });
  });

  it('大模板列表展开后仍保持直接响应式 grid 容器，避免虚拟行破坏自适应布局', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: Array.from({ length: 30 }, (_, index) => ({
                id: `template-${index + 1}`,
                name: `Template ${index + 1}`,
                summary: `Template summary ${index + 1}`,
                files: ['AGENTS.md'],
              })),
            },
          },
        };
      }
      return undefined;
    });

    renderSubagentsPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Template Library' }));

    const firstTemplateTitle = await screen.findByText('Template 1');
    const templateGrid = firstTemplateTitle.closest('.grid');

    expect(templateGrid).not.toBeNull();
    expect(templateGrid?.className).toContain('grid-cols-1');
    expect(templateGrid?.className).toContain('md:grid-cols-2');
    expect(templateGrid?.className).toContain('xl:grid-cols-3');
    expect(templateGrid?.parentElement?.className).toContain('max-h-[56vh]');
    expect(templateGrid?.parentElement?.className).toContain('overflow-y-auto');
  });
});
