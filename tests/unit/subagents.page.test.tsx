import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SubAgents } from '@/pages/SubAgents';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';
import { __resetSubagentTemplateCatalogCacheForTest } from '@/services/openclaw/subagent-template-catalog';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="router-location">{`${location.pathname}${location.search}`}</div>;
}

function renderSubagentsPage(initialEntries: string[] = ['/subagents']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <SubAgents />
    </MemoryRouter>,
  );
}

describe('subagents page', () => {
  const createAgent = vi.fn().mockResolvedValue('writer');
  const createAgentFromTemplate = vi.fn().mockResolvedValue('brand-guardian');
  const updateAgent = vi.fn().mockResolvedValue(undefined);
  const deleteAgent = vi.fn().mockResolvedValue(undefined);
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
      return undefined;
    });
    createAgent.mockClear();
    createAgentFromTemplate.mockClear();
    updateAgent.mockClear();
    deleteAgent.mockClear();
    loadAgents.mockClear();
    loadAvailableModels.mockClear();
    generateDraftFromPrompt.mockClear();
    cancelDraft.mockClear();
    loadPersistedFilesForAgent.mockClear();

    i18n.changeLanguage('en');
    useGatewayStore.setState({
      status: {
        state: 'stopped',
        port: 18789,
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
          identityEmoji: '⚙️',
          isDefault: true,
        },
        {
          id: 'agent-alpha',
          name: 'Alpha',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'gpt-4o-mini',
          identityEmoji: '📊',
          isDefault: false,
        },
      ],
      availableModels: [
        { id: 'gpt-4.1-mini', provider: 'openai' },
        { id: 'claude-3-7-sonnet', provider: 'anthropic' },
      ],
      modelsLoading: false,
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      error: null,
      managedAgentId: null,
      draftPromptByAgent: {},
      draftGeneratingByAgent: {},
      draftApplyingByAgent: {},
      draftApplySuccessByAgent: {},
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
      generateDraftFromPrompt,
      cancelDraft,
    });
  });

  it('renders agents in a card grid', () => {
    renderSubagentsPage();

    expect(screen.getByTestId('subagent-card-grid')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('agent-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('agent-avatar-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-avatar-agent-alpha')).toBeInTheDocument();
  });

  it('挂载时触发初始化加载', () => {
    useSubagentsStore.setState({
      agents: [],
      availableModels: [],
    });
    renderSubagentsPage();
    expect(loadAgents).toHaveBeenCalledTimes(1);
    expect(loadAvailableModels).toHaveBeenCalledTimes(1);
  });

  it('网关恢复到 running 后会自动重载数据', async () => {
    renderSubagentsPage();
    expect(loadAgents).toHaveBeenCalledTimes(1);
    expect(loadAvailableModels).toHaveBeenCalledTimes(1);

    act(() => {
      useGatewayStore.setState({
        status: {
          state: 'running',
          port: 18789,
        },
      });
    });

    await waitFor(() => {
      expect(loadAgents).toHaveBeenCalledTimes(2);
    });
    expect(loadAvailableModels).toHaveBeenCalledTimes(2);
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

  it('opens create dialog when clicking add button', () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));

    expect(screen.getByRole('dialog', { name: 'Create Subagent' })).toBeInTheDocument();
  });

  it('submits create form and calls createAgent', async () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));
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

  it('create dialog no longer renders emoji input', () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));

    expect(screen.queryByLabelText('Emoji')).toBeNull();
    expect(screen.getByText('Avatar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'avatar-style-pixelArt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'avatar-style-bottts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'avatar-style-botttsNeutral' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('supports selecting an avatar option and avatar style when creating subagent', async () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));
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

  it('opens detail view when clicking manage button', () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'Manage agent-alpha' }));

    expect(loadPersistedFilesForAgent).toHaveBeenCalledWith('agent-alpha');
    expect(screen.getByText('Managing: agent-alpha')).toBeInTheDocument();
  });

  it('submits prompt to generate subagent draft', async () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'Manage agent-alpha' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'draft policy docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Draft' }));

    await waitFor(() => {
      expect(generateDraftFromPrompt).toHaveBeenCalledWith('agent-alpha', 'draft policy docs');
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit agent-alpha' }));
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

  it('edit dialog no longer renders skill configuration section', () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit agent-alpha' }));
    expect(screen.queryByText('Skill Configuration')).toBeNull();
    expect(screen.queryByText('Web Search')).toBeNull();
    expect(screen.queryByText('Feishu Doc')).toBeNull();
  });

  it('编辑时不应把已删除模型补回下拉选项，并在单模型场景自动回填', () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/home/dev/.openclaw/workspace',
          model: 'gpt-main',
          identityEmoji: '⚙️',
          isDefault: true,
        },
        {
          id: 'agent-alpha',
          name: 'Alpha',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'legacy/removed-model',
          identityEmoji: '📊',
          isDefault: false,
        },
      ],
      availableModels: [
        { id: 'openai/gpt-4.1-mini', provider: 'openai' },
      ],
      modelsLoading: false,
    });

    renderSubagentsPage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit agent-alpha' }));

    const modelSelect = screen.getByLabelText('Model');
    expect(screen.queryByRole('option', { name: 'legacy/removed-model' })).toBeNull();
    expect(modelSelect).toHaveValue('openai/gpt-4.1-mini');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('does not render set-default action buttons', () => {
    renderSubagentsPage();

    expect(screen.queryByRole('button', { name: 'Set default main' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set default agent-alpha' })).toBeNull();
  });

  it('blocks create when name conflicts with existing slug', () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'agent alpha' } });

    expect(screen.getByText('Agent name is duplicated.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('keeps main editable/manageable but still blocks deletion', () => {
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
          identityEmoji: '⚙️',
          isDefault: true,
        },
        {
          id: 'agent-no-model',
          name: 'NoModel',
          workspace: '/home/dev/.openclaw/workspace-subagents/no-model',
          model: undefined,
          identityEmoji: '📉',
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
              templates: [
                {
                  id: 'brand-guardian',
                  name: 'Brand Guardian',
                  emoji: '🎨',
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
                emoji: '🎨',
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
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Load Template' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load Template' }));

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
            emoji: '🎨',
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
                emoji: '🤖',
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
