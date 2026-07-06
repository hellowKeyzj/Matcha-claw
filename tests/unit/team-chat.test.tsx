import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/services/openclaw/team-runtime-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/openclaw/team-runtime-client')>();
  return {
    ...actual,
    readTeamWebhookAuth: vi.fn(async () => ({
      success: true,
      enabled: true,
      source: 'settings',
      headerName: 'x-matchaclaw-webhook-token',
      authorizationScheme: 'Bearer',
      maskedToken: 'mctwh_…oken',
      copySupported: false,
    })),
  };
});

import { useTeamsStore } from '@/stores/teams';
import { useGatewayStore } from '@/stores/gateway';
import { readTeamWebhookAuth } from '@/services/openclaw/team-runtime-client';
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
            runId: 'team-1',
            packageName: 'ascendc-team',
            packageVersion: '1.0.0',
            sourcePath: '.tmp/team-skill',
            status: 'waiting_for_user',
            currentStageId: 'stage-1',
            revision: 2,
            createdAt: 1,
            updatedAt: 2,
            sessions: [],
          },
        ],
      },
      runsById: {
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
              config: { prompt: 'Draft the design blueprint' },
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
              label: 'ready for review',
              status: 'running',
            },
          ],
          updatedAt: 2,
        },
      },
      workflowPlanByTeamId: { 'team-1': null },
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
      refreshSnapshot: vi.fn().mockResolvedValue(undefined),
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

  it('renders the workflow canvas as the primary Team view and keeps only run list plus roles outside it', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Run graph')).toBeInTheDocument();
    expect(screen.getByLabelText('Run List')).toBeInTheDocument();
    expect(screen.getByLabelText('Team roles')).toBeInTheDocument();
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
    expect(screen.queryByText('Approvals')).not.toBeInTheDocument();
    expect(screen.queryByText('Artifacts')).not.toBeInTheDocument();
    expect(screen.queryByText('Gates')).not.toBeInTheDocument();
    expect(screen.queryByText('Kickbacks')).not.toBeInTheDocument();
    expect(screen.queryByText('Messages')).not.toBeInTheDocument();
    expect(screen.queryByText('Decisions')).not.toBeInTheDocument();
    expect(screen.queryByText('Events')).not.toBeInTheDocument();
    expect(screen.queryByText('Design Artifact')).not.toBeInTheDocument();
    expect(screen.queryByText('Need decision')).not.toBeInTheDocument();
  });

  it('renders a normalized graph with kindless nodes visible', async () => {
    useTeamsStore.setState({
      graphByTeamId: {
        'team-1': {
          runId: 'team-1',
          workflowPlanId: 'workflow-plan-1',
          status: 'running',
          nodes: [
            {
              nodeId: 'analysis-work-node',
              title: 'Work node without kind',
              roleId: 'operator-designer',
              status: 'running',
              config: { prompt: 'Continue the work' },
            },
            {
              nodeId: 'review-node',
              kind: 'review',
              title: 'Review work',
              roleId: 'reviewer',
              status: 'pending',
            },
          ],
          edges: [
            {
              edgeId: 'review-edge',
              sourceNodeId: 'analysis-work-node',
              targetNodeId: 'review-node',
              sourcePort: 'completed',
              label: 'ready for review',
              status: 'running',
            },
          ],
          updatedAt: 3,
        },
      },
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Work node without kind')).toBeInTheDocument();
    expect(screen.getByText('2 nodes · 1 edges')).toBeInTheDocument();
  });

  it('opens edge configuration from the canvas edge and saves port settings without local scheduling', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const edgeGroup = screen.getByLabelText('Workflow edges').querySelector('g')!;
    expect(screen.queryByRole('button', { name: 'completed' })).not.toBeInTheDocument();
    fireEvent.mouseEnter(edgeGroup);
    fireEvent.click((await screen.findAllByRole('button', { name: 'completed' }))[0]!);
    fireEvent.click(screen.getByLabelText('Workflow canvas'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'completed' })).not.toBeInTheDocument());

    fireEvent.mouseEnter(edgeGroup);
    fireEvent.click((await screen.findAllByRole('button', { name: 'completed' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Source port'), { target: { value: 'completed' } });
    fireEvent.change(within(dialog).getByLabelText('Edge label'), { target: { value: 'completed path' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save connection' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          edges: expect.arrayContaining([
            expect.objectContaining({
              edgeId: 'edge-design-review',
              sourcePort: 'completed',
              edgeType: 'completed_success',
              label: 'completed path',
              action: 'activate',
              payload: { includeUpstreamResult: true },
            }),
          ]),
        }),
      );
    });
  });

  it('opens node configuration from the canvas node and saves the selected agent', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const nodeCard = (await screen.findAllByText('Design blueprint'))[0]!.closest('[role="button"]');
    expect(nodeCard).not.toBeNull();
    fireEvent.click(nodeCard!);
    fireEvent.change(await screen.findByLabelText('Role ID'), { target: { value: 'reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save node' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              nodeId: 'workflow-task:task-design',
              roleId: 'reviewer',
              executor: expect.objectContaining({ kind: 'team-role', roleId: 'reviewer' }),
            }),
          ]),
        }),
      );
    });
  });

  it('shows node-kind specific configuration fields instead of the shared non-start form', async () => {
    useTeamsStore.setState({
      graphByTeamId: {
        'team-1': {
          runId: 'team-1',
          status: 'running',
          nodes: [
            {
              nodeId: 'work-node',
              kind: 'work',
              title: 'Role work',
              roleId: 'operator-designer',
              taskId: 'work-node',
              executor: { kind: 'team-role', roleId: 'operator-designer' },
              config: { prompt: 'Do role work' },
            },
            {
              nodeId: 'review-node',
              kind: 'review',
              title: 'Agent review',
              roleId: 'reviewer',
              executor: { kind: 'team-role', roleId: 'reviewer' },
              config: { prompt: 'Review role work' },
            },
            {
              nodeId: 'decision-node',
              kind: 'human_decision',
              title: 'Manual decision',
              executor: { kind: 'human' },
              config: { reason: 'Needs human call' },
            },
            {
              nodeId: 'script-node',
              kind: 'script_review',
              title: 'Policy check',
              executor: { kind: 'script', runtime: 'python' },
              config: { ruleId: 'passThrough' },
            },
            {
              nodeId: 'end-node',
              kind: 'end',
              title: 'Finish flow',
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

    fireEvent.click((await screen.findAllByText('Role work'))[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Work prompt')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Output artifact kind')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Agent review').closest('[role="button"]')!);
    expect(within(dialog).getByLabelText('Review mode')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Review prompt')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Manual decision').closest('[role="button"]')!);
    expect(within(dialog).getByLabelText('Decision reason')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Requested action')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Role ID')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Work prompt')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Policy check').closest('[role="button"]')!);
    expect(within(dialog).getByLabelText('Check rule')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Role ID')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Work prompt')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Finish flow').closest('[role="button"]')!);
    expect(within(dialog).getByText('End nodes only mark the workflow terminal point. If the leader must summarize, add a Leader Work node before End.')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Role ID')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Work prompt')).not.toBeInTheDocument();
  });

  it('saves ScriptReviewNode rule config without turning it into a role prompt node', async () => {
    useTeamsStore.setState({
      graphByTeamId: {
        'team-1': {
          runId: 'team-1',
          status: 'running',
          nodes: [
            {
              nodeId: 'script-node',
              kind: 'script_review',
              title: 'Policy check',
              roleId: 'operator-designer',
              executor: { kind: 'script', runtime: 'python' },
              config: { ruleId: 'passThrough', prompt: 'legacy prompt' },
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

    fireEvent.click((await screen.findAllByText('Policy check'))[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Check rule'), { target: { value: 'assertArtifactExists' } });
    fireEvent.change(await within(dialog).findByLabelText('Artifact kind'), { target: { value: 'nodeSummary' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              nodeId: 'script-node',
              roleId: undefined,
              executor: expect.objectContaining({ kind: 'script', runtime: 'python' }),
              config: expect.objectContaining({ ruleId: 'assertArtifactExists', artifactKind: 'nodeSummary' }),
            }),
          ]),
        }),
      );
    });
  });

  it('configures a StartNode webhook path, previews the runtime-host route, and keeps the token masked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    useTeamsStore.setState({
      graphByTeamId: {
        'team-1': {
          runId: 'team-1',
          status: 'running',
          nodes: [
            {
              nodeId: 'start-1',
              kind: 'start',
              title: 'Webhook start',
              status: 'pending',
              config: { trigger: { mode: 'webhook', path: '' } },
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

    const nodeCard = (await screen.findAllByText('Webhook start'))[0]!.closest('[role="button"]');
    expect(nodeCard).not.toBeNull();
    fireEvent.click(nodeCard!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Webhook path'), { target: { value: '/deploy/ready/' } });
    fireEvent.change(within(dialog).getByLabelText('Public ingress base URL'), { target: { value: 'https://hooks.example.com/' } });

    await waitFor(() => expect(readTeamWebhookAuth).toHaveBeenCalled());
    expect(within(dialog).getByText('/api/team-runtime/webhooks/deploy/ready')).toBeInTheDocument();
    expect(within(dialog).getByText('https://hooks.example.com/api/team-runtime/webhooks/deploy/ready')).toBeInTheDocument();
    expect(within(dialog).getByText('mctwh_…oken')).toBeInTheDocument();
    expect(within(dialog).queryByText('mctwh_test-token')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy token' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://hooks.example.com/api/team-runtime/webhooks/deploy/ready'));
    expect(within(dialog).getAllByRole('button', { name: 'Copied' }).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              nodeId: 'start-1',
              config: expect.objectContaining({
                trigger: { mode: 'webhook', path: 'deploy/ready', publicBaseUrl: 'https://hooks.example.com' },
              }),
            }),
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

    const nodeCard = (await screen.findAllByText('Design blueprint'))[0]!.closest('[role="button"]');
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

  it('adds Team graph nodes from the palette without running local scheduling', async () => {
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
              executor: expect.objectContaining({ kind: 'script', runtime: 'python' }),
              config: expect.objectContaining({ runtime: 'python', timeoutMs: 60_000 }),
              metadata: expect.objectContaining({ position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }) }),
            }),
          ]),
        }),
      );
    });
  });

  it('connects nodes through canvas ports and persists the edge', async () => {
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
              label: 'completed',
              kind: 'projection',
            }),
          ]),
        }),
      );
    });
  });

  it('drags nodes on the canvas and persists node position metadata', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    const nodeCard = screen.getAllByText('Design blueprint')[0]!.closest('[role="button"]');
    expect(nodeCard).not.toBeNull();
    fireEvent.pointerDown(nodeCard!, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(nodeCard, { pointerId: 1, clientX: 132, clientY: 148 });
    fireEvent.pointerUp(nodeCard, { pointerId: 1, clientX: 132, clientY: 148 });

    await waitFor(() => {
      expect(useTeamsStore.getState().saveGraph).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              nodeId: 'workflow-task:task-design',
              metadata: expect.objectContaining({
                position: expect.objectContaining({ x: 104, y: 120 }),
              }),
            }),
          ]),
        }),
      );
    });
  });

  it('syncs run list before refreshing snapshot on mount without starting the TeamRun', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(useTeamsStore.getState().syncRunList).toHaveBeenCalledWith('team-1');
      expect(useTeamsStore.getState().refreshSnapshot).toHaveBeenCalledWith('team-1');
    });
    const syncRunListOrder = vi.mocked(useTeamsStore.getState().syncRunList).mock.invocationCallOrder[0];
    const refreshSnapshotOrder = vi.mocked(useTeamsStore.getState().refreshSnapshot).mock.invocationCallOrder[0];
    expect(syncRunListOrder).toBeLessThan(refreshSnapshotOrder);
    expect(screen.queryByRole('button', { name: 'Start Run' })).not.toBeInTheDocument();
  });

  it('selects a run from the run list and refreshes the selected snapshot', async () => {
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
            ...useTeamsStore.getState().runsById['team-1']!,
            runId: 'teamrun-old',
            status: 'completed',
            revision: 1,
            updatedAt: 1,
            sessions: [],
          },
          {
            ...useTeamsStore.getState().runsById['team-1']!,
            runId: 'teamrun-new',
            status: 'running',
            revision: 2,
            updatedAt: 2,
            sessions: [],
          },
        ],
      },
      runsById: {
        'teamrun-old': {
          ...useTeamsStore.getState().runsById['team-1']!,
          runId: 'teamrun-old',
          status: 'completed',
          revision: 1,
          updatedAt: 1,
        },
        'teamrun-new': {
          ...useTeamsStore.getState().runsById['team-1']!,
          runId: 'teamrun-new',
          status: 'running',
          revision: 2,
          updatedAt: 2,
        },
      },
      runByTeamId: {
        'team-1': {
          ...useTeamsStore.getState().runsById['team-1']!,
          runId: 'teamrun-new',
          status: 'running',
          revision: 2,
          updatedAt: 2,
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
      expect(useTeamsStore.getState().refreshSnapshot).toHaveBeenCalledWith('team-1');
    });
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

  it('enables cancel while the run is waiting for user but does not render separate decision UI', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'Stop Run' })).toBeEnabled();
    expect(screen.queryByText('Waiting Run Decision')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit Decision' })).not.toBeInTheDocument();
  });

  it('disables cancel for completed runs', async () => {
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
