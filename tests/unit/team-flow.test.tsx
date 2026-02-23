import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { TeamChat } from '@/pages/Teams/TeamChat';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import {
  runAgentAndCollectFinalOutput,
  runAgentAndCollectFinalText,
  runAgentAndCollectReportWithRun,
} from '@/pages/Teams/lib/orchestrator';

vi.mock('@/pages/Teams/lib/orchestrator', () => ({
  runAgentAndCollectFinalOutput: vi.fn().mockResolvedValue({
    runId: 'run-controller-1',
    text: '{"action":"keep_research","reply":"let us continue discussion"}',
    usedTools: [],
  }),
  runAgentAndCollectFinalText: vi.fn().mockResolvedValue('hello from agent'),
  runAgentAndCollectReportWithRun: vi.fn().mockResolvedValue({
    runId: 'run-1',
    text: 'REPORT: {"reportId":"r1","task_id":"task-1","agent_id":"a1","status":"done","result":["ok"]}',
    report: {
      reportId: 'r1',
      task_id: 'task-1',
      agent_id: 'a1',
      status: 'done',
      result: ['ok'],
    },
  }),
  deleteTeamSessions: vi.fn().mockResolvedValue(undefined),
}));

describe('team flow', () => {
  const waitUntilChatReady = async () => {
    await waitFor(() => {
      expect(screen.queryByText(/Team members are not ready/i)).not.toBeInTheDocument();
    });
  };

  beforeEach(() => {
    i18n.changeLanguage('en');
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team 1',
          controllerId: 'a1',
          memberIds: ['a1', 'a2'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeTeamId: 'team-1',
      teamContexts: {},
      teamReports: {},
      teamMessagesById: {},
      teamSessionKeys: {
        'team-1': {
          a1: 'agent:a1:team:team-1',
          a2: 'agent:a2:team:team-1',
        },
      },
      teamPhaseById: {
        'team-1': 'discussion',
      },
      agentLatestOutput: {},
      teamPlans: {},
      teamTasksById: {},
      teamMemberRuntimeById: {},
      teamAuditById: {},
    });
    useSubagentsStore.setState({
      agents: [
        {
          id: 'a1',
          name: 'Agent A',
          workspace: '/workspace/a1',
          model: 'gpt-4o-mini',
          isDefault: false,
        },
        {
          id: 'a2',
          name: 'Agent B',
          workspace: '/workspace/a2',
          model: 'gpt-4o-mini',
          isDefault: false,
        },
      ],
      availableModels: [{ id: 'gpt-4o-mini' }],
      loading: false,
      error: null,
    });
    vi.mocked(runAgentAndCollectFinalOutput).mockClear();
    vi.mocked(runAgentAndCollectFinalText).mockClear();
    vi.mocked(runAgentAndCollectReportWithRun).mockClear();
  });

  it('collects discussion replies from team members', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    fireEvent.change(screen.getByPlaceholderText(/Message/i), { target: { value: 'hello team' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      expect(runAgentAndCollectFinalOutput).toHaveBeenCalledTimes(1);
    });
  });

  it('treats keep_research with question-like reply as ask_user and stops loop', async () => {
    vi.mocked(runAgentAndCollectFinalOutput)
      .mockResolvedValueOnce({
        runId: 'run-controller-1',
        text: '{"action":"keep_research","reply":"Please confirm target platforms first?"}',
        usedTools: [],
      })
      .mockResolvedValueOnce({
        runId: 'run-controller-2',
        text: '{"action":"ready_for_planning","reply":"ready"}',
        usedTools: [],
      });

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    fireEvent.change(screen.getByPlaceholderText(/Message/i), { target: { value: 'continue' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      expect(runAgentAndCollectFinalOutput).toHaveBeenCalledTimes(1);
    });

    const phase = useTeamsStore.getState().teamPhaseById['team-1'];
    expect(phase).toBe('discussion');
  });


  it('downgrades ready_for_planning with open questions to ask_user', async () => {
    vi.mocked(runAgentAndCollectFinalOutput)
      .mockResolvedValueOnce({
        runId: 'run-controller-1',
        text: '{\"action\":\"ready_for_planning\",\"reply\":\"Can you confirm scope?\",\"questions\":[\"confirm scope\"]}',
        usedTools: [],
      })
      .mockResolvedValueOnce({
        runId: 'run-controller-2',
        text: '{\"action\":\"ready_for_planning\",\"reply\":\"ready\"}',
        usedTools: [],
      });

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    fireEvent.change(screen.getByPlaceholderText(/Message/i), { target: { value: 'need v2' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      expect(runAgentAndCollectFinalOutput).toHaveBeenCalledTimes(1);
    });

    const phase = useTeamsStore.getState().teamPhaseById['team-1'];
    expect(phase).toBe('discussion');
  });

  it('moves to convergence when controller outputs structured plan', async () => {
    vi.mocked(runAgentAndCollectFinalOutput)
      .mockResolvedValueOnce({
        runId: 'run-controller-1',
        text: '{"action":"ready_for_planning","reply":"ready"}',
        usedTools: [],
      })
      .mockResolvedValueOnce({
        runId: 'run-controller-2',
        text: JSON.stringify({
          objective: 'Build automation',
          tasks: [
            {
              taskId: 'task-a1',
              agentId: 'a1',
              instruction: 'Design workflow',
              acceptance: ['has milestones'],
            },
          ],
        }),
        usedTools: [],
      });
    vi.mocked(runAgentAndCollectFinalText).mockResolvedValueOnce(JSON.stringify({
        objective: 'Build automation',
        tasks: [
          {
            taskId: 'task-a1',
            agentId: 'a1',
            instruction: 'Design workflow',
            acceptance: ['has milestones'],
          },
        ],
      }));

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    fireEvent.change(screen.getByPlaceholderText(/Message/i), { target: { value: 'need plan' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      const currentPhase = useTeamsStore.getState().teamPhaseById['team-1'];
      expect(['convergence', 'team-setup']).toContain(currentPhase);
    });
  });

  it('retries when report is missing and marks task as missing-report', async () => {
    useTeamsStore.setState((state) => ({
      ...state,
      teamPhaseById: { ...state.teamPhaseById, 'team-1': 'execution' },
      teamTasksById: {
        ...state.teamTasksById,
        'team-1': [{
          taskId: 'task-a1',
          agentId: 'a1',
          instruction: 'do work',
          acceptance: ['done'],
          status: 'pending',
          attempts: 0,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    }));

    vi.mocked(runAgentAndCollectReportWithRun)
      .mockResolvedValueOnce({
        runId: 'run-1',
        text: 'no report',
        report: null,
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        text: 'still no report',
        report: null,
      });

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    fireEvent.change(screen.getByPlaceholderText(/Message/i), { target: { value: 'execute' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      expect(runAgentAndCollectReportWithRun).toHaveBeenCalledTimes(2);
      const task = (useTeamsStore.getState().teamTasksById['team-1'] ?? [])[0];
      expect(task?.status).toBe('missing-report');
    });
  });

  it('shows visible system error when an agent reply fails in discussion', async () => {
    vi.mocked(runAgentAndCollectFinalOutput)
      .mockRejectedValueOnce(new Error('agent failed'));

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    fireEvent.change(screen.getByPlaceholderText(/Message/i), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      const messages = useTeamsStore.getState().teamMessagesById['team-1'] ?? [];
      expect(messages.some((msg) => msg.role === 'system' && msg.content.includes('agent failed'))).toBe(true);
    });
  });

  it('switches to execution when clicking confirm execution', async () => {
    useTeamsStore.setState((state) => ({
      ...state,
      teamPhaseById: { ...state.teamPhaseById, 'team-1': 'convergence' },
      teamTasksById: {
        ...state.teamTasksById,
        'team-1': [{
          taskId: 'task-a1',
          agentId: 'a1',
          instruction: 'do work',
          acceptance: ['done'],
          status: 'pending',
          attempts: 0,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    }));
    vi.mocked(runAgentAndCollectReportWithRun).mockResolvedValueOnce({
      runId: 'run-1',
      text: 'REPORT: {"reportId":"r1","task_id":"task-a1","agent_id":"a1","status":"done","result":["ok"]}',
      report: {
        reportId: 'r1',
        task_id: 'task-a1',
        agent_id: 'a1',
        status: 'done',
        result: ['ok'],
      },
    });

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    fireEvent.click(screen.getByRole('button', { name: /Confirm execution/i }));

    await waitFor(() => {
      expect(useTeamsStore.getState().teamPhaseById['team-1']).toBe('execution');
    });
  });

  it('uses chat mode in convergence stage until explicit review action', async () => {
    useTeamsStore.setState((state) => ({
      ...state,
      teamPhaseById: { ...state.teamPhaseById, 'team-1': 'convergence' },
      teamPlans: {
        ...state.teamPlans,
        'team-1': {
          objective: 'Build automation',
          tasks: [
            {
              taskId: 'task-a1',
              agentId: 'a1',
              instruction: 'Design workflow',
              acceptance: ['has milestones'],
            },
          ],
        },
      },
      teamTasksById: {
        ...state.teamTasksById,
        'team-1': [{
          taskId: 'task-a1',
          agentId: 'a1',
          instruction: 'do work',
          acceptance: ['done'],
          status: 'pending',
          attempts: 0,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    }));

    vi.mocked(runAgentAndCollectFinalOutput).mockResolvedValueOnce({
      runId: 'run-controller-chat-1',
      text: 'chat reply',
      usedTools: [],
    });

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    fireEvent.change(screen.getByPlaceholderText(/Message/i), { target: { value: 'why this plan?' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      expect(runAgentAndCollectFinalOutput).toHaveBeenCalledTimes(1);
    });

    const firstCall = vi.mocked(runAgentAndCollectFinalOutput).mock.calls[0]?.[0];
    expect(firstCall?.message).toContain('[CONVERGENCE_CHAT_MODE]');
    expect(firstCall?.message).not.toContain('[CONVERGENCE_ROUND]');
  });

  it('runs convergence review only after clicking start review', async () => {
    useTeamsStore.setState((state) => ({
      ...state,
      teamPhaseById: { ...state.teamPhaseById, 'team-1': 'convergence' },
      teamPlans: {
        ...state.teamPlans,
        'team-1': {
          objective: 'Build automation',
          tasks: [
            {
              taskId: 'task-a1',
              agentId: 'a1',
              instruction: 'Design workflow',
              acceptance: ['has milestones'],
            },
          ],
          risks: [],
        },
      },
      teamTasksById: {
        ...state.teamTasksById,
        'team-1': [{
          taskId: 'task-a1',
          agentId: 'a1',
          instruction: 'do work',
          acceptance: ['done'],
          status: 'pending',
          attempts: 0,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    }));

    vi.mocked(runAgentAndCollectFinalOutput)
      .mockResolvedValueOnce({
        runId: 'review-r1',
        text: '{"agent_id":"a2","verdict":"approve","summary":"ok","blockers":[],"required_decisions":[],"suggestions":[]}',
        usedTools: [],
      })
      .mockResolvedValueOnce({
        runId: 'digest-r1',
        text: '{"status":"ready","summary":"ready","agreements":[],"conflicts":[],"open_questions":[]}',
        usedTools: [],
      })
      .mockResolvedValueOnce({
        runId: 'blueprint-r1',
        text: '{"action":"ready_to_execute","reply":"ready","must_fix":[],"required_decisions_resolved":true,"assumptions":[]}',
        usedTools: [],
      });

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    expect(runAgentAndCollectFinalOutput).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Start review/i }));

    await waitFor(() => {
      expect(runAgentAndCollectFinalOutput).toHaveBeenCalledTimes(3);
    });

    const firstCall = vi.mocked(runAgentAndCollectFinalOutput).mock.calls[0]?.[0];
    expect(firstCall?.message).toContain('[CONVERGENCE_ROUND]');
  });

  it('routes @member 回答 to the specified member in convergence chat mode', async () => {
    useTeamsStore.setState((state) => ({
      ...state,
      teamPhaseById: { ...state.teamPhaseById, 'team-1': 'convergence' },
      teamPlans: {
        ...state.teamPlans,
        'team-1': {
          objective: 'Build automation',
          tasks: [
            {
              taskId: 'task-a1',
              agentId: 'a1',
              instruction: 'Design workflow',
              acceptance: ['has milestones'],
            },
          ],
        },
      },
      teamTasksById: {
        ...state.teamTasksById,
        'team-1': [{
          taskId: 'task-a1',
          agentId: 'a1',
          instruction: 'do work',
          acceptance: ['done'],
          status: 'pending',
          attempts: 0,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    }));

    vi.mocked(runAgentAndCollectFinalOutput).mockResolvedValueOnce({
      runId: 'run-member-chat-1',
      text: 'member reply',
      usedTools: [],
    });

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    await waitUntilChatReady();
    fireEvent.change(screen.getByPlaceholderText(/Message/i), { target: { value: '@a2 回答 你怎么看这版方案' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() => {
      expect(runAgentAndCollectFinalOutput).toHaveBeenCalledTimes(1);
    });

    const firstCall = vi.mocked(runAgentAndCollectFinalOutput).mock.calls[0]?.[0];
    expect(firstCall?.agentId).toBe('a2');
    expect(firstCall?.message).toContain('[CONVERGENCE_MEMBER_CHAT_MODE]');
  });
});
