import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useTeamsStore } from '@/stores/teams';
import { useGatewayStore } from '@/stores/gateway';
import { TeamChat } from '@/pages/Teams/TeamChat';
import i18n from '@/i18n';

describe('team chat', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
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
          leadAgentId: 'a1',
          memberIds: ['a1', 'a2'],
          packagePath: '.tmp/team-skill',
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
      stagesByTeamId: {
        'team-1': [
          {
            runId: 'team-1',
            stageId: 'stage-1',
            title: 'Design blueprint',
            executor: 'operator-designer',
            roleId: 'operator-designer',
            status: 'waiting_for_user',
            attempt: 1,
            maxAttempts: 2,
            inputArtifactIds: [],
            outputArtifactIds: [],
            createdAt: 1,
            updatedAt: 2,
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
  });

  it('renders TeamRun stages, approvals, roles and messages', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Workflow Stages')).toBeInTheDocument();
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(screen.getByText('Roles')).toBeInTheDocument();
    expect(screen.getByText('Artifacts')).toBeInTheDocument();
    expect(screen.getByText('Gates')).toBeInTheDocument();
    expect(screen.getByText('Kickbacks')).toBeInTheDocument();
    expect(screen.getByText('Decisions')).toBeInTheDocument();
    expect(screen.getByText('Design blueprint')).toBeInTheDocument();
    expect(screen.getByText('Design Artifact')).toBeInTheDocument();
    expect(screen.getByText('design: DESIGN-COMPLETE')).toBeInTheDocument();
    expect(screen.getByText('missing_section: Add Memory Layout')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.getByText('Need decision')).toBeInTheDocument();
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
      approvalsByTeamId: { 'team-1': [] },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start Run' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().startRun).toHaveBeenCalledWith('team-1');
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
