import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SubAgents } from '@/pages/SubAgents';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';

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
  const createAgent = vi.fn().mockResolvedValue(undefined);
  const updateAgent = vi.fn().mockResolvedValue(undefined);
  const deleteAgent = vi.fn().mockResolvedValue(undefined);
  const generateDraftFromPrompt = vi.fn().mockResolvedValue(undefined);
  const cancelDraft = vi.fn().mockResolvedValue(undefined);
  const loadPersistedFilesForAgent = vi.fn().mockResolvedValue({});

  beforeEach(() => {
    createAgent.mockClear();
    updateAgent.mockClear();
    deleteAgent.mockClear();
    generateDraftFromPrompt.mockClear();
    cancelDraft.mockClear();
    loadPersistedFilesForAgent.mockClear();

    i18n.changeLanguage('en');
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
      loading: false,
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
      loadAgents: vi.fn().mockResolvedValue(undefined),
      loadAvailableModels: vi.fn().mockResolvedValue(undefined),
      loadPersistedFilesForAgent,
      selectAgent: vi.fn(),
      createAgent,
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
    expect(screen.getByTestId('agent-emoji-main')).toHaveTextContent('⚙️');
    expect(screen.getByTestId('agent-emoji-agent-alpha')).toHaveTextContent('📊');
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
      expect(createAgent).toHaveBeenCalledWith({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: 'gpt-4.1-mini',
      });
    });
  });

  it('passes selected emoji when creating subagent', async () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.change(screen.getByLabelText('Emoji'), { target: { value: '🤖' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: 'gpt-4.1-mini',
        emoji: '🤖',
      });
    });
  });

  it('supports emoji quick-pick grid selection', async () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show emoji quick picks' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick-emoji-🔥' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: 'gpt-4.1-mini',
        emoji: '🔥',
      });
    });
  });

  it('prefills manage prompt from create dialog initial prompt', async () => {
    renderSubagentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'New Subagent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.change(screen.getByLabelText('Initial Prompt'), {
      target: { value: 'act as a finance analyst' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: 'gpt-4.1-mini',
      });
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

  it('disables edit/delete/manage but keeps chat available for main agent', () => {
    renderSubagentsPage();

    expect(screen.getByRole('button', { name: 'Edit main' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete main' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Manage main' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Chat main' })).toBeEnabled();
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
});
