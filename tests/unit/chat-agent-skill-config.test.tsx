import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import i18n from '@/i18n';

describe('chat slash skill behavior', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
    } as never);

    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'Main', workspace: '/workspace/main', model: 'gpt-main', isDefault: true },
        { id: 'test', name: 'Test Agent', workspace: '/workspace/test', model: 'gpt-4.1-mini', isDefault: false },
      ],
      loadAgents: vi.fn().mockResolvedValue(undefined),
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
      messages: [],
      loading: false,
      error: null,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      sessions: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ],
      currentSessionKey: 'agent:test:main',
      sessionLabels: {},
      sessionLastActivity: {},
      sessionRuntimeByKey: {},
      showThinking: true,
      thinkingLevel: null,
      pendingApprovalsBySession: {},
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      switchSession: vi.fn(),
      sendMessage: vi.fn(),
      abortRun: vi.fn(),
      clearError: vi.fn(),
      cleanupEmptySession: vi.fn(),
      resolveApproval: vi.fn(),
      refresh: vi.fn(),
      toggleThinking: vi.fn(),
    } as never);

    useSkillsStore.setState({
      skills: [
        { id: 'web-search', name: 'Web Search', description: 'web', enabled: true, eligible: true, icon: '🌐' },
        { id: 'feishu-doc', name: 'Feishu Doc', description: 'doc', enabled: true, eligible: true, icon: '📄' },
        { id: 'disabled-skill', name: 'Disabled Skill', description: 'disabled', enabled: false, eligible: true, icon: '🚫' },
      ],
      loading: false,
      fetchSkills: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('chat 页面不显示技能配置按钮', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'Skill Configuration' })).toBeNull();
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
});
