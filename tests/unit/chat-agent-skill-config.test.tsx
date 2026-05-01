import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { AgentSkillConfigPanel } from '@/pages/Chat/components/AgentSkillConfigPanel';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import i18n from '@/i18n';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('chat agent skill configuration', () => {
  const updateAgent = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    i18n.changeLanguage('en');
    window.localStorage.removeItem('chat:side-panel-open');
    window.localStorage.removeItem('chat:side-panel-tab');
    updateAgent.mockClear();

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
    } as never);

    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'Main', workspace: '/workspace/main', model: 'gpt-main', isDefault: true },
        { id: 'test', name: 'Test Agent', workspace: '/workspace/test', model: 'gpt-4.1-mini', isDefault: false },
      ],
      loadAgents: vi.fn().mockResolvedValue(undefined),
      updateAgent,
    } as never);

    useTaskInboxStore.setState({
      tasks: [],
      loading: false,
      initialized: true,
      error: null,
      workspaceDirs: [],
      workspaceLabel: null,
      submittingTaskIds: [],
      init: vi.fn().mockResolvedValue(undefined),
      refreshTasks: vi.fn().mockResolvedValue(undefined),
      submitDecision: vi.fn().mockResolvedValue(undefined),
      submitFreeText: vi.fn().mockResolvedValue(undefined),
      openTaskSession: vi.fn().mockReturnValue({ switched: false, reason: 'task_not_found' }),
      handleGatewayNotification: vi.fn(),
      clearError: vi.fn(),
    } as never);

    useChatStore.setState({
      mutating: false,
      error: null,
      foregroundHistorySessionKey: null,
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      currentSessionKey: 'agent:test:main',
      loadedSessions: {
        'agent:test:main': {
          ...createEmptySessionRecord(),
          meta: {
            ...createEmptySessionRecord().meta,
            ready: true,
          },
        },
      },
      showThinking: true,
      pendingApprovalsBySession: {},
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      sendMessage: vi.fn(),
      abortRun: vi.fn(),
      clearError: vi.fn(),
      cleanupEmptySession: vi.fn(),
      resolveApproval: vi.fn(),
      refresh: vi.fn(),
      toggleThinking: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn(),
    } as never);

    useSkillsStore.setState({
      skills: [
        { id: 'web-search', name: 'Web Search', description: 'web', enabled: true, eligible: true, icon: '🌐' },
        { id: 'feishu-doc', name: 'Feishu Doc', description: 'doc', enabled: true, eligible: true, icon: '📄' },
        { id: 'clawflow', name: 'Clawflow', description: 'flow', enabled: true, eligible: true, icon: '🪝' },
        { id: 'disabled-skill', name: 'Disabled Skill', description: 'disabled', enabled: false, eligible: true, icon: '🚫' },
      ],
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      fetchSkills: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('opens the shared side panel on the skills tab and updates current agent allowlist', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open side panel' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Skill Configuration' }));

    expect(screen.getByRole('tab', { name: 'Skill Configuration' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Skill Configuration · Test Agent')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Web Search' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Feishu Doc' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Disabled Skill' })).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Web Search' }));

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'test',
        skills: ['feishu-doc', 'clawflow'],
      }));
    });
  });

  it('keeps the latest multi-toggle skill intent when the side panel closes during an in-flight sync', async () => {
    const firstUpdate = createDeferred<void>();
    const secondUpdate = createDeferred<void>();
    let updateCount = 0;

    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'Main', workspace: '/workspace/main', model: 'gpt-main', isDefault: true },
        { id: 'test', name: 'Test Agent', workspace: '/workspace/test', model: 'gpt-4.1-mini', isDefault: false, skills: [] },
      ],
    } as never);

    updateAgent.mockImplementation(async (input) => {
      updateCount += 1;
      if (updateCount === 1) {
        await firstUpdate.promise;
      } else if (updateCount === 2) {
        await secondUpdate.promise;
      }

      useSubagentsStore.setState({
        agents: [
          { id: 'main', name: 'Main', workspace: '/workspace/main', model: 'gpt-main', isDefault: true },
          {
            id: 'test',
            name: 'Test Agent',
            workspace: '/workspace/test',
            model: 'gpt-4.1-mini',
            isDefault: false,
            skills: Array.isArray(input.skills) ? input.skills : [],
          },
        ],
      } as never);
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open side panel' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Skill Configuration' }));

    fireEvent.click(screen.getByRole('switch', { name: 'Web Search' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Feishu Doc' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Clawflow' }));

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledTimes(1);
      expect(updateAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({
        agentId: 'test',
        skills: ['web-search'],
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close side panel' }));

    firstUpdate.resolve();

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledTimes(2);
      expect(updateAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
        agentId: 'test',
        skills: ['web-search', 'feishu-doc', 'clawflow'],
      }));
    });

    secondUpdate.resolve();

    await waitFor(() => {
      expect(useSubagentsStore.getState().agents.find((agent) => agent.id === 'test')?.skills).toEqual([
        'web-search',
        'feishu-doc',
        'clawflow',
      ]);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open side panel' }));

    expect(screen.getByRole('switch', { name: 'Web Search' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Feishu Doc' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Clawflow' })).toHaveAttribute('aria-checked', 'true');
  });

  it('slash 只展示当前 agent 已配置的技能', async () => {
    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'Main', workspace: '/workspace/main', model: 'gpt-main', isDefault: true },
        { id: 'test', name: 'Test Agent', workspace: '/workspace/test', model: 'gpt-4.1-mini', isDefault: false, skills: ['feishu-doc'] },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    expect(screen.getByRole('option', { name: /feishu doc/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /web search/i })).toBeNull();
  });

  it('renders the inline skill list as immediate switches without save actions', () => {
    render(
      <AgentSkillConfigPanel
        title="Skill Configuration · Test Agent"
        skillOptions={[
          { id: 'web-search', name: 'Web Search', description: 'web', icon: '🌐' },
          { id: 'feishu-doc', name: 'Feishu Doc', description: 'doc', icon: '📄' },
        ]}
        skillsLoading={false}
        selectedSkillIds={['feishu-doc']}
        onToggleSkill={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText('Skill Configuration · Test Agent')).toBeInTheDocument();

    const webSearchSwitch = screen.getByRole('switch', { name: 'Web Search' });
    const feishuDocSwitch = screen.getByRole('switch', { name: 'Feishu Doc' });
    expect(webSearchSwitch).not.toBeDisabled();
    expect(feishuDocSwitch).not.toBeDisabled();
  });
});
