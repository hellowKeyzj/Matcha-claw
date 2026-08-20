import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useTeamsStore } from '@/stores/teams';
import { useRuntimeHostStore } from '@/stores/gateway';
import { TeamChat } from '@/pages/Teams/TeamChat';
import i18n from '@/i18n';

describe('team chat', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    localStorage.removeItem('teams-runtime-store');
    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
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
      runIdsByTeamId: { 'team-1': ['team-1'] },
      runListByTeamId: {
        'team-1': [
          {
            state: 'available',
            teamId: 'team-1',
            runId: 'team-1',
            teamRevision: 2,
            graphStatus: 'waiting',
          },
        ],
      },
      runsById: {
        'team-1': {
          state: 'available',
          teamId: 'team-1',
          runId: 'team-1',
          teamRevision: 2,
          graphStatus: 'waiting',
        },
      },
      runByTeamId: {
        'team-1': {
          state: 'available',
          teamId: 'team-1',
          runId: 'team-1',
          teamRevision: 2,
          graphStatus: 'waiting',
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
          {
            runId: 'team-1',
            roleId: 'reviewer',
            agentId: 'a2',
            agentName: 'Agent A2',
            workspaceDir: '/workspace/reviewer',
            agentDir: '/agent/reviewer',
            skills: [],
            tools: [],
            status: 'idle',
          },
        ],
      },
      stagesByTeamId: { 'team-1': [] },
      graphByTeamId: {
        'team-1': {
          runId: 'team-1',
          workflowPlanId: 'workflow-plan-1',
          status: 'running',
          nodes: [
            {
              nodeId: 'workflow-task:task-design',
              kind: 'work',
              title: 'Design blueprint',
              roleId: 'operator-designer',
              taskId: 'task-design',
              status: 'running',
              maxAttempts: 1,
            },
            {
              nodeId: 'workflow-task:task-review',
              kind: 'review',
              title: 'Review design',
              roleId: 'operator-designer',
              taskId: 'task-review',
              status: 'pending',
            },
          ],
          edges: [
            {
              edgeId: 'edge-design-review',
              sourceNodeId: 'workflow-task:task-design',
              targetNodeId: 'workflow-task:task-review',
              sourcePort: 'completed',
              targetPort: 'input',
              action: 'activate',
            },
          ],
          updatedAt: 2,
        },
      },
      workflowPlanByTeamId: { 'team-1': null },
      publicProjectionByTeamId: { 'team-1': {} },
      dispatchGroupsByTeamId: {},
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
            stageId: 'stage-1',
            roleId: 'operator-designer',
            reason: 'Need NPU authorization',
            requestedAction: 'Run profiling',
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
      dispatchesByTeamId: {},
      dispatchExecutionsByTeamId: {},
      gatesByTeamId: {},
      kickbacksByTeamId: {},
      decisionsByTeamId: {},
      eventsByTeamId: { 'team-1': [] },
      eventsByRunId: { 'team-1': [] },
      eventCursorByTeamId: { 'team-1': 1 },
      eventCursorByRunId: { 'team-1': 1 },
      loadingByTeamId: { 'team-1': false },
      errorByTeamId: { 'team-1': undefined },
      setActiveTeam: vi.fn(),
      setActiveRun: vi.fn(),
      createRun: vi.fn().mockResolvedValue(undefined),
      deleteRun: vi.fn().mockResolvedValue(undefined),
      refreshActiveRunViews: vi.fn().mockResolvedValue(undefined),
      refreshPublicProjection: vi.fn().mockResolvedValue(undefined),
      refreshPendingApprovals: vi.fn().mockResolvedValue(undefined),
      syncRunList: vi.fn().mockResolvedValue(undefined),
      resumeRun: vi.fn().mockResolvedValue(undefined),
      cancelRun: vi.fn().mockResolvedValue(undefined),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      submitDecision: vi.fn().mockResolvedValue(undefined),
      saveGraph: vi.fn().mockResolvedValue(undefined),
      exportGraphYaml: vi.fn().mockResolvedValue({ fileName: 'team-run-graph.yaml', yaml: 'nodes: []\n' }),
      importGraphYaml: vi.fn().mockResolvedValue({ success: true, imported: true }),
    } as never);
  });

  it('exports the current graph as a sanitized YAML download without saving or ticking the run', async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:team-run-graph-yaml');
    const revokeObjectURL = vi.fn();
    const clickedAnchors: HTMLAnchorElement[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function recordClickedAnchor(this: HTMLAnchorElement) {
      clickedAnchors.push(this);
    });
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    vi.mocked(useTeamsStore.getState().exportGraphYaml).mockResolvedValueOnce({
      fileName: 'Unsafe:Graph',
      yaml: 'nodes:\n  - id: start\n',
    });

    try {
      render(
        <MemoryRouter>
          <TeamChat teamId="team-1" />
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Export YAML' }));

      await waitFor(() => {
        expect(useTeamsStore.getState().exportGraphYaml).toHaveBeenCalledWith('team-1');
        expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
        expect(clickedAnchors).toHaveLength(1);
      });
      const downloadedBlob = createObjectURL.mock.calls[0]?.[0];
      expect(downloadedBlob).toBeInstanceOf(Blob);
      await expect((downloadedBlob as Blob).text()).resolves.toBe('nodes:\n  - id: start\n');
      expect(clickedAnchors[0]?.download).toBe('Unsafe-Graph.yaml');
      expect(clickedAnchors[0]?.href).toBe('blob:team-run-graph-yaml');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:team-run-graph-yaml');
      expect(useTeamsStore.getState().saveGraph).not.toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', { value: originalCreateObjectURL, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: originalRevokeObjectURL, configurable: true });
    }
  });

  it('imports a YAML file through the team store without saving from the canvas', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const file = new File(['nodes:\n  - id: start\n'], 'graph.yaml', { type: 'application/yaml' });
    fireEvent.change(await screen.findByLabelText('Import YAML file'), { target: { files: [file] } });

    await waitFor(() => {
      expect(useTeamsStore.getState().importGraphYaml).toHaveBeenCalledWith('team-1', 'nodes:\n  - id: start\n');
    });
    expect(useTeamsStore.getState().saveGraph).not.toHaveBeenCalled();
  });

  it('creates a new run directly from a populated graph without opening a copy prompt', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New Run' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().createRun).toHaveBeenCalledWith('team-1');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('creates a new run directly when there is no graph to copy', async () => {
    useTeamsStore.setState({
      graphByTeamId: { 'team-1': { runId: 'team-1', status: 'draft', nodes: [], edges: [], updatedAt: 3 } },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New Run' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().createRun).toHaveBeenCalledWith('team-1');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the workflow canvas as the primary Team view without private role bindings', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Run graph')).toBeInTheDocument();
    expect(screen.getByLabelText('Run List')).toBeInTheDocument();
    expect(screen.queryByLabelText('Team roles')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Roles' })).not.toBeInTheDocument();
    expect(screen.getByText('2 nodes · 1 edges')).toBeInTheDocument();
    expect(screen.getByLabelText('Workflow canvas')).toBeInTheDocument();
    expect(screen.getByText('Node palette')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Reviewer role checks upstream work.')).toBeInTheDocument();
    expect(screen.getAllByText('out: passed').length).toBeGreaterThan(0);
    expect(screen.queryByText('Source node')).not.toBeInTheDocument();
    expect(screen.queryByText('Target node')).not.toBeInTheDocument();
    expect(screen.queryByText('ready for review')).not.toBeInTheDocument();
    expect(screen.getAllByText('Design blueprint').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Review design').length).toBeGreaterThan(0);
    expect(screen.getAllByText('operator-designer').length).toBeGreaterThan(0);
    expect(screen.queryByText('Agent A1')).not.toBeInTheDocument();
    expect(screen.queryByText('/workspace')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.queryByText('Artifacts')).not.toBeInTheDocument();
    expect(screen.queryByText('Gates')).not.toBeInTheDocument();
    expect(screen.queryByText('Kickbacks')).not.toBeInTheDocument();
    expect(screen.queryByText('Messages')).not.toBeInTheDocument();
    expect(screen.queryByText('Decisions')).not.toBeInTheDocument();
    expect(screen.queryByText('Events')).not.toBeInTheDocument();
    expect(screen.queryByText('Design Artifact')).not.toBeInTheDocument();
    expect(screen.queryByText('Need decision')).not.toBeInTheDocument();
  });

  it('opens edge configuration from the canvas edge and saves final port and action facts', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const edgeGroup = screen.getByLabelText('Workflow edges').querySelector('svg > g')!;
    fireEvent.click(edgeGroup.querySelector('path')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('When upstream result is'), { target: { value: 'failed' } });
    fireEvent.change(within(dialog).getByLabelText('Action'), { target: { value: 'rework' } });
    fireEvent.change(within(dialog).getByLabelText('Target port'), { target: { value: 'retry-input' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save connection' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          edges: expect.arrayContaining([
            expect.objectContaining({
              edgeId: 'edge-design-review',
              sourcePort: 'failed',
              targetPort: 'retry-input',
              action: 'rework',
            }),
          ]),
        }),
      );
    });
  });

  it('opens a Work node configuration and saves its final role and task facts', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const canvas = await screen.findByLabelText('Workflow canvas');
    const nodeCard = (await within(canvas).findAllByText('Design blueprint'))[0]!.closest('[role="button"]');
    expect(nodeCard).not.toBeNull();
    fireEvent.click(nodeCard!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Role ID'), { target: { value: 'reviewer' } });
    fireEvent.change(within(dialog).getByLabelText('Task ID'), { target: { value: 'task-review-ready' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              nodeId: 'workflow-task:task-design',
              roleId: 'reviewer',
              taskId: 'task-review-ready',
            }),
          ]),
        }),
      );
    });
  });

  it('limits node editors to final graph facts', async () => {
    useTeamsStore.setState({
      graphByTeamId: {
        'team-1': {
          runId: 'team-1',
          status: 'running',
          nodes: [
            { nodeId: 'work-node', kind: 'work', title: 'Role work', roleId: 'operator-designer', taskId: 'task-role-work', maxAttempts: 1 },
            { nodeId: 'review-node', kind: 'review', title: 'Agent review', maxAttempts: 1 },
            { nodeId: 'decision-node', kind: 'human_decision', title: 'Manual decision', maxAttempts: 1 },
            { nodeId: 'script-node', kind: 'script_review', title: 'Policy check', maxAttempts: 1 },
            { nodeId: 'end-node', kind: 'end', title: 'Finish flow', maxAttempts: 1 },
          ],
          edges: [],
          updatedAt: 2,
        },
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const canvas = await screen.findByLabelText('Workflow canvas');
    fireEvent.click((await within(canvas).findAllByText('Role work'))[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Role ID')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Task ID')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Work prompt')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Output artifact kind')).toBeInTheDocument();

    fireEvent.click(within(canvas).getByText('Agent review').closest('[role="button"]')!);
    expect(within(dialog).queryByLabelText('Role ID')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Review prompt')).not.toBeInTheDocument();

    fireEvent.click(within(canvas).getByText('Manual decision').closest('[role="button"]')!);
    expect(within(dialog).queryByLabelText('Decision reason')).not.toBeInTheDocument();

    fireEvent.click(within(canvas).getByText('Policy check').closest('[role="button"]')!);
    expect(within(dialog).queryByLabelText('Check rule')).not.toBeInTheDocument();

    fireEvent.click(within(canvas).getByText('Finish flow').closest('[role="button"]')!);
    expect(within(dialog).queryByLabelText('Role ID')).not.toBeInTheDocument();
  });

  it('configures a StartNode cron trigger every 15 minutes through the custom schedule form', async () => {
    useTeamsStore.setState({
      graphByTeamId: {
        'team-1': {
          runId: 'team-1',
          status: 'running',
          nodes: [
            {
              nodeId: 'start-1',
              kind: 'start',
              title: 'Schedule start',
              status: 'pending',
              maxAttempts: 1,
              trigger: { kind: 'webhook', path: '' },
            },
          ],
          edges: [],
          updatedAt: 2,
        },
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const nodeCard = (await screen.findAllByText('Schedule start'))[0]!.closest('[role="button"]');
    expect(nodeCard).not.toBeNull();
    fireEvent.click(nodeCard!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Trigger'), { target: { value: 'cron' } });

    expect(within(dialog).getByLabelText('Schedule')).toHaveValue('every10Minutes');

    fireEvent.change(within(dialog).getByLabelText('Schedule'), { target: { value: 'custom' } });
    expect(within(dialog).queryByLabelText('Cron expression')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Custom schedule')).toHaveValue('intervalMinutes');

    fireEvent.change(within(dialog).getByLabelText('Custom schedule'), { target: { value: 'intervalMinutes' } });
    fireEvent.change(within(dialog).getByLabelText('Every N minutes'), { target: { value: '15' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              nodeId: 'start-1',
              trigger: { kind: 'cron', expression: '*/15 * * * *' },
            }),
          ]),
        }),
      );
    });
  });

  it('configures a StartNode webhook fact without exposing an HTTP route or token', async () => {
    useTeamsStore.setState({
      graphByTeamId: {
        'team-1': {
          runId: 'team-1',
          nodes: [{ nodeId: 'start-1', kind: 'start', title: 'Webhook start', maxAttempts: 1, trigger: { kind: 'webhook', path: '' } }],
          edges: [],
        },
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const nodeCard = (await screen.findAllByText('Webhook start'))[0]!.closest('[role="button"]');
    expect(nodeCard).not.toBeNull();
    fireEvent.click(nodeCard!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Webhook path'), { target: { value: '/deploy/ready/' } });
    expect(within(dialog).queryByText('Public ingress base URL')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Webhook token')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ nodeId: 'start-1', trigger: { kind: 'webhook', path: 'deploy/ready' } }),
          ]),
        }),
      );
    });
  });

  it('deletes nodes from the configuration sheet and removes attached edges', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const canvas = await screen.findByLabelText('Workflow canvas');
    const nodeCard = (await within(canvas).findAllByText('Design blueprint'))[0]!.closest('[role="button"]');
    expect(nodeCard).not.toBeNull();
    fireEvent.click(nodeCard!);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete node' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          nodes: expect.not.arrayContaining([expect.objectContaining({ nodeId: 'workflow-task:task-design' })]),
          edges: expect.not.arrayContaining([expect.objectContaining({ edgeId: 'edge-design-review' })]),
        }),
      );
    });
  });

  it('deletes edges from the edge configuration sheet', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.mouseEnter(screen.getByLabelText('Workflow edges').querySelector('g')!);
    fireEvent.click((await screen.findAllByRole('button', { name: 'completed' }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete edge' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          edges: expect.not.arrayContaining([expect.objectContaining({ edgeId: 'edge-design-review' })]),
        }),
      );
    });
  });

  it('adds final graph nodes from the palette without legacy executor or config facts', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Script check/ }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              kind: 'script_review',
              title: 'Script check',
              maxAttempts: 1,
            }),
          ]),
        }),
      );
    });
    const savedGraph = vi.mocked(useTeamsStore.getState().saveGraph).mock.calls[0]?.[1];
    const addedNode = savedGraph?.nodes.find((node) => node.kind === 'script_review');
    expect(addedNode).not.toHaveProperty('executor');
    expect(addedNode).not.toHaveProperty('config');
    expect(addedNode).not.toHaveProperty('metadata');
  });

  it('connects nodes through canvas ports with final edge facts', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Connect from Design blueprint' }));
    expect(screen.getByText(/Connecting: completed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Review design' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          edges: expect.arrayContaining([
            expect.objectContaining({
              sourceNodeId: 'workflow-task:task-design',
              targetNodeId: 'workflow-task:task-review',
              sourcePort: 'completed',
              targetPort: 'input',
              action: 'activate',
            }),
          ]),
        }),
      );
    });
  });

  it('keeps canvas node drag positions local instead of saving metadata', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const canvas = await screen.findByLabelText('Workflow canvas');
    const nodeCard = within(canvas).getAllByText('Design blueprint')[0]!.closest('[role="button"]');
    expect(nodeCard).not.toBeNull();
    fireEvent.pointerDown(nodeCard!, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(nodeCard, { pointerId: 1, clientX: 132, clientY: 148 });
    fireEvent.pointerUp(nodeCard, { pointerId: 1, clientX: 132, clientY: 148 });

    await waitFor(() => {
      expect(nodeCard).toHaveStyle({ left: '104px', top: '120px' });
    });
    expect(useTeamsStore.getState().saveGraph).not.toHaveBeenCalled();
  });

  it('syncs the run list before refreshing the public projection on mount without starting the TeamRun', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(useTeamsStore.getState().syncRunList).toHaveBeenCalledWith('team-1');
      expect(useTeamsStore.getState().refreshPublicProjection).toHaveBeenCalledWith('team-1');
    });
    const syncRunListOrder = vi.mocked(useTeamsStore.getState().syncRunList).mock.invocationCallOrder[0];
    const refreshPublicProjectionOrder = vi.mocked(useTeamsStore.getState().refreshPublicProjection).mock.invocationCallOrder[0];
    expect(syncRunListOrder).toBeLessThan(refreshPublicProjectionOrder);
    expect(useTeamsStore.getState().refreshActiveRunViews).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Start Run' })).not.toBeInTheDocument();
  });

  it('selects a run from the run list and refreshes its public projection', async () => {
    useTeamsStore.setState({
      teams: [
        {
          ...useTeamsStore.getState().teams[0]!,
          activeRunId: 'teamrun-new',
        },
      ],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runListByTeamId: {
        'team-1': [
          {
            state: 'available',
            teamId: 'team-1',
            runId: 'teamrun-old',
            teamRevision: 1,
            graphStatus: 'completed',
          },
          {
            state: 'available',
            teamId: 'team-1',
            runId: 'teamrun-new',
            teamRevision: 2,
            graphStatus: 'running',
          },
        ],
      },
      runsById: {
        'teamrun-old': {
          state: 'available',
          teamId: 'team-1',
          runId: 'teamrun-old',
          teamRevision: 1,
          graphStatus: 'completed',
        },
        'teamrun-new': {
          state: 'available',
          teamId: 'team-1',
          runId: 'teamrun-new',
          teamRevision: 2,
          graphStatus: 'running',
        },
      },
      runByTeamId: {
        'team-1': {
          state: 'available',
          teamId: 'team-1',
          runId: 'teamrun-new',
          teamRevision: 2,
          graphStatus: 'running',
        },
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('Run List'), { target: { value: 'teamrun-old' } });

    await waitFor(() => {
      expect(useTeamsStore.getState().setActiveRun).toHaveBeenCalledWith('team-1', 'teamrun-old');
      expect(useTeamsStore.getState().refreshPublicProjection).toHaveBeenCalledWith('team-1');
    });
    expect(useTeamsStore.getState().refreshActiveRunViews).not.toHaveBeenCalled();
  });

  it('shows an empty run hint when no run exists while still rendering the canvas shell', async () => {
    useTeamsStore.setState({
      runIdsByTeamId: { 'team-1': [] },
      runListByTeamId: { 'team-1': [] },
      runsById: {},
      runByTeamId: {},
      graphByTeamId: { 'team-1': null },
      dispatchTasksByTeamId: { 'team-1': [] },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No runs yet. Create a run, then open the leader session and send a message to run it.')).toBeInTheDocument();
    expect(screen.getByLabelText('Workflow canvas')).toBeInTheDocument();
    expect(screen.queryByText('Waiting Run Decision')).not.toBeInTheDocument();
  });

  it('renders the dedicated public approval projection and resolves each explicit decision', async () => {
    const resolveApproval = vi.fn().mockResolvedValue(undefined);
    useTeamsStore.setState({ resolveApproval } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Approvals' })).toBeInTheDocument();
    const approvalCard = screen.getByRole('article');
    expect(within(approvalCard).getByText('approval-1')).toBeInTheDocument();
    expect(within(approvalCard).getByText('stage-1')).toBeInTheDocument();
    expect(within(approvalCard).getByText('operator-designer')).toBeInTheDocument();
    expect(within(approvalCard).getByText('Need NPU authorization')).toBeInTheDocument();
    expect(within(approvalCard).getByText('Run profiling')).toBeInTheDocument();
    expect(within(approvalCard).getByRole('time')).toHaveAttribute('datetime', '1970-01-01T00:00:00.002Z');
    expect(within(approvalCard).queryByText('Uses live NPU')).not.toBeInTheDocument();
    expect(within(approvalCard).queryByText('approval-1:approval')).not.toBeInTheDocument();

    fireEvent.click(within(approvalCard).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith('team-1', 'approval-1', 'approve'));

    resolveApproval.mockClear();
    fireEvent.click(within(approvalCard).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith('team-1', 'approval-1', 'deny'));

    resolveApproval.mockClear();
    fireEvent.click(within(approvalCard).getByRole('button', { name: 'Abort' }));
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith('team-1', 'approval-1', 'abort'));
  });

  it('keeps approval controls idempotent while resolving and surfaces resolution errors', async () => {
    let releaseResolution!: () => void;
    const resolveApproval = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      releaseResolution = resolve;
    }));
    useTeamsStore.setState({ resolveApproval } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const approveButton = await within(screen.getByRole('article')).findByRole('button', { name: 'Approve' });
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);
    expect(resolveApproval).toHaveBeenCalledTimes(1);
    expect(approveButton).toBeDisabled();

    releaseResolution();
    await waitFor(() => expect(approveButton).toBeEnabled());

    resolveApproval.mockRejectedValueOnce(new Error('approval unavailable'));
    fireEvent.click(approveButton);
    expect(await screen.findByText('approval unavailable')).toBeInTheDocument();
  });

  it('enables cancel while the run is waiting for user without replacing approval UI', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'Stop Run' })).toBeEnabled();
    expect(screen.queryByText('Waiting Run Decision')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Approvals' })).toBeInTheDocument();
  });

  it('disables cancel for completed runs', async () => {
    useTeamsStore.setState({
      runByTeamId: {
        'team-1': {
          ...useTeamsStore.getState().runByTeamId['team-1']!,
          graphStatus: 'completed',
        },
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'Stop Run' })).toBeDisabled();
  });

  it('guards duplicate UI actions while an action is in flight', async () => {
    let releaseResume!: () => void;
    const resumeRun = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      releaseResume = resolve;
    }));
    useTeamsStore.setState({ resumeRun } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const resumeButton = await screen.findByRole('button', { name: 'Resume Run' });
    fireEvent.click(resumeButton);
    fireEvent.click(resumeButton);
    releaseResume();

    await waitFor(() => {
      expect(resumeRun).toHaveBeenCalledTimes(1);
    });
  });
});
