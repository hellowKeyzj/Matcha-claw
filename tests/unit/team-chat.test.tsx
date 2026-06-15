import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useTeamsStore } from '@/stores/teams';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { TeamChat } from '@/pages/Teams/TeamChat';
import i18n from '@/i18n';

const invokeIpcMock = vi.hoisted(() => vi.fn());
const pickLocalSkillSourceMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
  };
});

vi.mock('@/services/local-path-picker', () => ({
  pickLocalSkillSource: (...args: unknown[]) => pickLocalSkillSourceMock(...args),
}));

describe('team chat', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    invokeIpcMock.mockReset();
    invokeIpcMock.mockResolvedValue(undefined);
    pickLocalSkillSourceMock.mockReset();
    localStorage.removeItem('teams-runtime-store');
    useGatewayStore.setState({
      status: {
        processState: 'running',
        transportState: 'connected',
        gatewayReady: true,
        gatewayUrl: 'http://127.0.0.1:18789',
        port: 18789,
      },
    });
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team 1',
          teamSkillName: 'ascendc-team',
          teamSkillVersion: '1.0.0',
          teamSkillDescription: 'AscendC team',
          packagePath: '.tmp/team-skill',
          sourcePath: '.tmp/team-skill/SKILL.md',
          activeRunId: 'team-1',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeTeamId: 'team-1',
      runByTeamId: {
        'team-1': {
          runId: 'team-1',
          packageName: 'ascendc-team',
          packageVersion: '1.0.0',
          sourcePath: '.tmp/team-skill',
          status: 'waiting_for_user',
          currentStageId: 'stage-1',
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
        },
      },
      rolesByTeamId: {
        'team-1': [
          {
            runId: 'team-1',
            roleId: 'operator-designer',
            agentId: 'a1',
            agentName: 'Agent A1',
            workspaceDir: '/workspace',
            agentDir: '/agent',
            skills: [],
            tools: [],
            status: 'idle',
          },
        ],
      },
      stagesByTeamId: { 'team-1': [] },
      workflowPlanByTeamId: {
        'team-1': {
          workflowPlanId: 'workflow-plan-1',
          runId: 'team-1',
          title: 'AscendC optimization plan',
          summary: 'Coordinate design and review work.',
          status: 'dispatched',
          groups: [
            {
              groupId: 'group-design',
              title: 'Design group',
              taskIds: ['task-design'],
              join: { requireCompleted: true, allowFailed: false, retryLimit: 1 },
            },
          ],
          tasks: [
            {
              taskId: 'task-design',
              roleId: 'operator-designer',
              title: 'Design blueprint',
              prompt: 'Prepare the design blueprint.',
              dependsOnTaskIds: [],
              outputArtifactKind: 'design_report',
            },
          ],
          idempotencyKey: 'workflow-plan-1',
          createdAt: 1,
        },
      },
      dispatchGroupsByTeamId: {
        'team-1': [
          {
            dispatchGroupId: 'dispatch-group-1',
            runId: 'team-1',
            workflowPlanId: 'workflow-plan-1',
            groupId: 'group-design',
            taskIds: ['task-design'],
            status: 'running',
            idempotencyKey: 'dispatch-group-1',
            createdAt: 2,
          },
        ],
      },
      dispatchTasksByTeamId: {
        'team-1': [
          {
            dispatchTaskId: 'dispatch-task-1',
            runId: 'team-1',
            workflowPlanId: 'workflow-plan-1',
            dispatchGroupId: 'dispatch-group-1',
            groupId: 'group-design',
            taskId: 'task-design',
            roleId: 'operator-designer',
            dispatchId: 'dispatch-1',
            status: 'running',
            idempotencyKey: 'dispatch-task-1',
            createdAt: 2,
          },
        ],
      },
      approvalsByTeamId: {
        'team-1': [
          {
            approvalId: 'approval-1',
            runId: 'team-1',
            stageId: 'stage-1',
            roleId: 'operator-designer',
            reason: 'Need NPU authorization',
            requestedAction: 'Run profiling',
            risk: 'Uses live NPU',
            status: 'pending',
            idempotencyKey: 'approval-1',
            createdAt: 2,
          },
        ],
      },
      artifactsByTeamId: {
        'team-1': [
          {
            artifactId: 'artifact-1',
            runId: 'team-1',
            stageId: 'stage-1',
            roleId: 'operator-designer',
            kind: 'design_report',
            title: 'Design Artifact',
            contentRef: 'artifacts/artifact-1.md',
            summary: 'Tiling plan ready',
            idempotencyKey: 'artifact-1',
            createdAt: 2,
          },
        ],
      },
      messagesByTeamId: {
        'team-1': [
          {
            messageId: 'm1',
            runId: 'team-1',
            fromRoleId: 'operator-designer',
            toRoleId: 'leader',
            summary: 'Need decision',
            body: 'Please review',
            idempotencyKey: 'm1',
            createdAt: 1,
          },
        ],
      },
      dispatchesByTeamId: { 'team-1': [] },
      dispatchExecutionsByTeamId: { 'team-1': [] },
      gatesByTeamId: {
        'team-1': [
          {
            gateId: 'gate-1',
            runId: 'team-1',
            stageId: 'stage-1',
            artifactId: 'artifact-1',
            gateType: 'design',
            verdict: 'DESIGN-COMPLETE',
            passed: true,
            failureItems: [],
            idempotencyKey: 'gate-1',
            createdAt: 2,
          },
        ],
      },
      kickbacksByTeamId: {
        'team-1': [
          {
            kickbackId: 'kickback-1',
            runId: 'team-1',
            stageId: 'stage-1',
            gateId: 'gate-1',
            failureItems: [{ code: 'missing_section', message: 'Add Memory Layout' }],
            idempotencyKey: 'kickback-1',
            createdAt: 2,
          },
        ],
      },
      decisionsByTeamId: {
        'team-1': [
          {
            decisionId: 'decision-1',
            runId: 'team-1',
            stageId: 'stage-1',
            decision: 'retry',
            note: 'Try again',
            idempotencyKey: 'decision-1',
            createdAt: 2,
          },
        ],
      },
      eventsByTeamId: { 'team-1': [] },
      eventCursorByTeamId: { 'team-1': 1 },
      loadingByTeamId: { 'team-1': false },
      errorByTeamId: { 'team-1': undefined },
      setActiveTeam: vi.fn(),
      ensureRunCreated: vi.fn().mockResolvedValue(undefined),
      startRun: vi.fn().mockResolvedValue(undefined),
      refreshSnapshot: vi.fn().mockResolvedValue(undefined),
      tickRun: vi.fn().mockResolvedValue(undefined),
      cancelRun: vi.fn().mockResolvedValue(undefined),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      submitDecision: vi.fn().mockResolvedValue(undefined),
    } as never);
    useSkillsStore.setState({
      installSkill: vi.fn().mockResolvedValue(undefined),
      importLocalSkill: vi.fn().mockResolvedValue('skill-key'),
      fetchSkills: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('renders TeamRun workflow plan, approvals, roles and messages', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Workflow Plan')).toBeInTheDocument();
    expect(screen.queryByText('Workflow Stages')).not.toBeInTheDocument();
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(screen.getByText('Roles')).toBeInTheDocument();
    expect(screen.getByText('Artifacts')).toBeInTheDocument();
    expect(screen.getByText('Gates')).toBeInTheDocument();
    expect(screen.getByText('Kickbacks')).toBeInTheDocument();
    expect(screen.getByText('Decisions')).toBeInTheDocument();
    expect(screen.getByText('AscendC optimization plan')).toBeInTheDocument();
    expect(screen.getByText('workflow-plan-1 · dispatched')).toBeInTheDocument();
    expect(screen.getByText('Design group')).toBeInTheDocument();
    expect(screen.getAllByText('running')).toHaveLength(2);
    expect(screen.getByText('Design blueprint')).toBeInTheDocument();
    expect(screen.getByText('task-design · operator-designer')).toBeInTheDocument();
    expect(screen.getByText('Tasks: 1')).toBeInTheDocument();
    expect(screen.getByText('Design Artifact')).toBeInTheDocument();
    expect(screen.getByText('design: DESIGN-COMPLETE')).toBeInTheDocument();
    expect(screen.getByText('missing_section: Add Memory Layout')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.getByText('Need decision')).toBeInTheDocument();
  });

  it('renders event payload summary fields', async () => {
    useTeamsStore.setState({
      eventsByTeamId: {
        'team-1': [
          {
            eventId: 'event-1',
            runId: 'team-1',
            revision: 3,
            type: 'leader:synthesis_skipped',
            payload: {
              reason: 'not_ready',
              workflowPlanId: 'workflow-plan-1',
            },
            createdAt: 3,
          },
        ],
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('leader:synthesis_skipped')).toBeInTheDocument();
    expect(screen.getByText('reason: not_ready', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('workflowPlanId: workflow-plan-1', { exact: false })).toBeInTheDocument();
  });

  it('refreshes snapshot on mount without auto-starting the TeamRun', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(useTeamsStore.getState().refreshSnapshot).toHaveBeenCalledWith('team-1');
    });
    expect(useTeamsStore.getState().startRun).not.toHaveBeenCalled();
  });

  it('disables start for a waiting TeamRun', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'Start Run' })).toBeDisabled();
    expect(useTeamsStore.getState().startRun).not.toHaveBeenCalled();
  });

  it('starts the TeamRun only from the explicit start button when no run exists', async () => {
    useTeamsStore.setState({
      runByTeamId: {},
      stagesByTeamId: { 'team-1': [] },
      workflowPlanByTeamId: { 'team-1': null },
      dispatchGroupsByTeamId: { 'team-1': [] },
      dispatchTasksByTeamId: { 'team-1': [] },
      approvalsByTeamId: { 'team-1': [] },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start Run' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().startRun).toHaveBeenCalledWith('team-1', expect.any(String));
    });
    expect(screen.getByText(/Run status:\s*Not started/)).toBeInTheDocument();
    expect(screen.queryByText('Waiting Run Decision')).not.toBeInTheDocument();
  });

  it('enables cancel and decision only while waiting for user', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'Cancel Run' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Submit Decision' })).toBeEnabled();
    expect(screen.getByText('Waiting Run Decision')).toBeInTheDocument();
  });

  it('renders dependency missing recovery UI without proceed degraded', async () => {
    useTeamsStore.setState({
      eventsByTeamId: {
        'team-1': [
          {
            eventId: 'dependency-1',
            runId: 'team-1',
            revision: 3,
            type: 'dependency:missing',
            payload: {
              stageId: 'stage-1',
              missingRequiredSkills: [{ name: 'investment-memo', required: true, purpose: 'Memo structure', source: 'https://skills.sh/?q=investment-memo' }],
              missingOptionalSkills: [],
              missingRequiredTools: [{ name: 'browser-mcp', required: true, purpose: 'Browser automation' }],
              missingOptionalTools: [],
            },
            createdAt: 3,
          },
        ],
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Dependencies required before this run can continue')).toBeInTheDocument();
    expect(screen.getByText('investment-memo')).toBeInTheDocument();
    expect(screen.getByText('browser-mcp')).toBeInTheDocument();
    expect(screen.queryByText('Waiting Run Decision')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Proceed Degraded' })).not.toBeInTheDocument();
  });

  it('opens non-ClawHub skill source, imports a downloaded local skill, then retries dependency preflight', async () => {
    const installSkill = vi.fn().mockResolvedValue(undefined);
    const importLocalSkill = vi.fn().mockResolvedValue('investment-memo');
    const fetchSkills = vi.fn().mockResolvedValue(undefined);
    pickLocalSkillSourceMock.mockResolvedValue('C:/Downloads/investment-memo/SKILL.md');
    useSkillsStore.setState({ installSkill, importLocalSkill, fetchSkills } as never);
    useTeamsStore.setState({
      eventsByTeamId: {
        'team-1': [
          {
            eventId: 'dependency-1',
            runId: 'team-1',
            revision: 3,
            type: 'dependency:missing',
            payload: {
              stageId: 'stage-1',
              missingRequiredSkills: [{ name: 'investment-memo', required: true, purpose: 'Memo structure', source: 'https://skills.sh/?q=investment-memo' }],
              missingOptionalSkills: [],
              missingRequiredTools: [],
              missingOptionalTools: [],
            },
            createdAt: 3,
          },
        ],
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Dependencies required before this run can continue')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install Skill' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import Local Skill' }));

    await waitFor(() => {
      expect(invokeIpcMock).toHaveBeenCalledWith('shell:openExternal', 'https://skills.sh/?q=investment-memo');
      expect(installSkill).not.toHaveBeenCalled();
      expect(importLocalSkill).toHaveBeenCalledWith('C:/Downloads/investment-memo/SKILL.md');
      expect(fetchSkills).toHaveBeenCalledWith({ force: true, fresh: true });
      expect(useTeamsStore.getState().submitDecision).toHaveBeenCalledWith(
        'team-1',
        'retry',
        'Retry after installing missing dependency skills.',
      );
      expect(useTeamsStore.getState().tickRun).toHaveBeenCalledWith('team-1');
    });
  });

  it('hides decision and disables cancel for completed runs', async () => {
    useTeamsStore.setState({
      runByTeamId: {
        'team-1': {
          ...useTeamsStore.getState().runByTeamId['team-1']!,
          status: 'completed',
        },
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'Cancel Run' })).toBeDisabled();
    expect(screen.queryByText('Waiting Run Decision')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit Decision' })).not.toBeInTheDocument();
  });

  it('resolves pending approval from approval action', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().resolveApproval).toHaveBeenCalledWith(
        'team-1',
        'approval-1',
        'approve',
        undefined,
      );
    });
  });

  it('guards duplicate UI actions while an action is in flight', async () => {
    let releaseTick!: () => void;
    const tickRun = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      releaseTick = resolve;
    }));
    useTeamsStore.setState({ tickRun } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const tickButton = await screen.findByRole('button', { name: 'Tick Run' });
    fireEvent.click(tickButton);
    fireEvent.click(tickButton);
    releaseTick();

    await waitFor(() => {
      expect(tickRun).toHaveBeenCalledTimes(1);
    });
  });
});
