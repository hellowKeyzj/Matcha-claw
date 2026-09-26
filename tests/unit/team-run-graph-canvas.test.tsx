import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TeamRunGraphCanvas } from '@/pages/Teams/TeamRunGraphCanvas';
import type { TeamGraphNodeRecord, TeamGraphSnapshotRecord } from '@/services/openclaw/team-runtime-client';
import teamsEn from '@/i18n/locales/en/teams.json';

const labels = {
  ...teamsEn.run.graphCanvas,
  workflowCanvas: 'Workflow canvas', workflowEdges: 'Workflow edges', nodePalette: 'Node palette',
  nodeConfiguration: 'Node configuration', nodeConfigurationDescription: 'Configure node',
  edgeConfiguration: 'Edge configuration', edgeConfigurationDescription: 'Configure edge',
  configureHint: 'Click to configure', clickNodeToEdit: 'click node to edit', saveNode: 'Save node',
  saveEdge: 'Save edge', deleteNode: 'Delete node', deleteEdge: 'Delete edge', addEdge: 'Add edge',
  sourceNode: 'Source node', targetNode: 'Target node', sourcePort: 'Source port', targetPort: 'Target port',
  edgeAction: 'Action', edgeActionOptions: { activate: 'Activate', rework: 'Rework', gate: 'Gate', finish: 'Finish' },
  edgeConnection: 'Connection', edgeTriggerCondition: 'When upstream result is', edgeJoinGateHint: 'Use gate',
  nodeTitle: 'Title', roleId: 'Role ID', taskId: 'Task ID', roleIdRequired: 'Role required', taskIdRequired: 'Task required',
  saveGraphUnavailable: 'Unavailable', connectionDraft: 'Connecting', runStatusLabel: 'Run status', graphStatusLabel: 'Graph status',
  statusValues: {}, teamRoles: 'Team roles', connectToNode: 'Connect to {{title}}', connectFromNode: 'Connect from {{title}}',
  nodeCount: '{{count}} nodes', edgeCount: '{{count}} edges', startTriggerMode: 'Trigger', startTriggerWebhook: 'Webhook',
  startTriggerCron: 'Cron', startWebhookPath: 'Webhook path', startWebhookPathPreview: 'Preview', startWebhookPathPreviewHint: 'Hint',
  startWebhookPathRequired: 'Path required', startWebhookPathInvalid: 'Path invalid', startCronSchedule: 'Schedule',
  startCronSchedules: { every10Minutes: '10m', every30Minutes: '30m', hourly: 'Hourly', dailyAt9: 'Daily', custom: 'Custom' },
  startCronCustomKind: 'Custom schedule', startCronCustomKinds: { intervalMinutes: 'Minutes', intervalHours: 'Hours', dailyAt: 'Daily' },
  startCronCustomIntervalMinutes: 'Every minutes', startCronCustomIntervalHours: 'Every hours', startCronCustomTime: 'Time',
  startCronCustomValueRequired: 'Cron required', startTriggerHint: 'Trigger hint', defaultOutputPort: 'Output', edges: 'Edges', noEdges: 'No edges',
  nodePaletteDescriptions: { start: 'Start', work: 'Work', review: 'Review', human_decision: 'Decision', script_review: 'Script', join: 'Join', end: 'End' },
  workPrompt: 'Work prompt', outputArtifactKind: 'Output artifact kind', groupId: 'Group ID',
  joinRequireCompleted: 'Require completed upstream nodes', joinAllowFailed: 'Allow failed upstream nodes', joinRetryLimit: 'Join retry limit',
  includeUpstreamResult: 'Include upstream result',
} as const;

function renderCanvas(graph: TeamGraphSnapshotRecord, onPatchGraph = vi.fn().mockResolvedValue(undefined)) {
  render(<TeamRunGraphCanvas graph={graph} emptyLabel="Empty" titleLabel="Run graph" executorLabel="Executor" labels={labels} onPatchGraph={onPatchGraph} />);
  return onPatchGraph;
}

const workGraph: TeamGraphSnapshotRecord = {
  graphId: 'graph-1', workflowPlanId: 'plan-1', runId: 'run-1', status: 'draft',
  nodes: [{ nodeId: 'work-1', kind: 'work', title: 'Work', roleId: 'builder', taskId: 'task-1', maxAttempts: 1 }],
  edges: [],
};

describe('TeamRunGraphCanvas typed graph fact editors', () => {
  it('edits work prompt, executor role, and artifact kind without private projections', async () => {
    const patchGraph = renderCanvas(workGraph);
    fireEvent.click(screen.getAllByText('Work')[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Role ID'), { target: { value: 'reviewer' } });
    fireEvent.change(within(dialog).getByLabelText('Work prompt'), { target: { value: 'Review the upstream result.' } });
    fireEvent.change(within(dialog).getByLabelText('Output artifact kind'), { target: { value: 'review-report' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));

    await waitFor(() => expect(patchGraph).toHaveBeenCalledWith([
      {
        op: 'replace_node',
        node: expect.objectContaining({
          nodeId: 'work-1', kind: 'work', roleId: 'reviewer', taskId: 'task-1',
          executor: { kind: 'team-role', roleId: 'reviewer' },
          config: expect.objectContaining({ prompt: 'Review the upstream result.', outputArtifactKind: 'review-report' }),
        }),
      },
    ]));
    expect(screen.queryByText('session-ref')).not.toBeInTheDocument();
  });

  it('adds nodes with bounded draft identifiers', async () => {
    const patchGraph = renderCanvas(workGraph);

    fireEvent.click(screen.getByRole('button', { name: /Role step/ }));

    await waitFor(() => expect(patchGraph).toHaveBeenCalledWith([
      {
        op: 'add_node',
        node: expect.objectContaining({
          nodeId: expect.stringMatching(/^draft-node:work:/),
          kind: 'work',
          roleId: 'leader',
          maxAttempts: 3,
        }),
      },
      {
        op: 'set_node_position',
        nodeId: expect.stringMatching(/^draft-node:work:/),
        position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      },
    ]));
    const nodeId = patchGraph.mock.calls[0]?.[0]?.[0]?.node?.nodeId;
    expect(nodeId).toHaveLength(52);
  });

  it('adds edges with bounded draft identifiers', async () => {
    const graph: TeamGraphSnapshotRecord = {
      ...workGraph,
      nodes: [
        { nodeId: 'source-node-with-a-very-long-public-projection-id', kind: 'work', title: 'Source', roleId: 'builder', taskId: 'task-1', maxAttempts: 1 },
        { nodeId: 'target-node-with-a-very-long-public-projection-id', kind: 'review', title: 'Target', roleId: 'reviewer', maxAttempts: 1 },
      ],
      edges: [],
    };
    const patchGraph = renderCanvas(graph);

    fireEvent.click(screen.getByLabelText('Connect from Source: completed'));
    fireEvent.click(screen.getByLabelText('Connect to Target'));

    await waitFor(() => expect(patchGraph).toHaveBeenCalledWith([
      {
        op: 'add_edge',
        edge: expect.objectContaining({
          edgeId: expect.stringMatching(/^draft-edge:projection:/),
          sourceNodeId: 'source-node-with-a-very-long-public-projection-id',
          targetNodeId: 'target-node-with-a-very-long-public-projection-id',
          sourcePort: 'completed',
          targetPort: 'input',
          action: 'activate',
        }),
      },
    ]));
    const edgeId = patchGraph.mock.calls[0]?.[0]?.[0]?.edge?.edgeId;
    expect(edgeId).toHaveLength(58);
  });

  it('adds review rework edges without changing either node budget', async () => {
    const graph: TeamGraphSnapshotRecord = {
      ...workGraph,
      nodes: [
        { nodeId: 'work-1', kind: 'work', title: 'Work', roleId: 'builder', taskId: 'task-1', maxAttempts: 1 },
        { nodeId: 'review-1', kind: 'review', title: 'Review', roleId: 'reviewer', maxAttempts: 1 },
      ],
      edges: [],
    };
    const patchGraph = renderCanvas(graph);

    fireEvent.click(screen.getByLabelText('Connect from Review: rework'));
    fireEvent.click(screen.getByLabelText('Connect to Work'));

    await waitFor(() => expect(patchGraph).toHaveBeenCalledWith([
      {
        op: 'add_edge',
        edge: expect.objectContaining({
          sourceNodeId: 'review-1',
          targetNodeId: 'work-1',
          sourcePort: 'rework',
          targetPort: 'input',
          action: 'rework',
          payload: { includeUpstreamResult: true },
        }),
      },
    ]));
  });

  it('keeps a completed review outlet as activation even when connecting back to completed work', async () => {
    const graph: TeamGraphSnapshotRecord = {
      ...workGraph,
      nodes: [
        { ...workGraph.nodes[0]!, status: 'completed' },
        { nodeId: 'review-1', kind: 'review', title: 'Review', roleId: 'reviewer', maxAttempts: 1 },
      ],
      edges: [{ edgeId: 'forward', sourceNodeId: 'work-1', targetNodeId: 'review-1', sourcePort: 'completed', targetPort: 'input', action: 'activate' }],
    };
    const patchGraph = renderCanvas(graph);

    fireEvent.click(screen.getByLabelText('Connect from Review: completed'));
    fireEvent.click(screen.getByLabelText('Connect to Work'));

    await waitFor(() => expect(patchGraph).toHaveBeenCalledWith([
      {
        op: 'add_edge',
        edge: expect.objectContaining({ sourceNodeId: 'review-1', targetNodeId: 'work-1', sourcePort: 'completed', action: 'activate' }),
      },
    ]));
    expect(graph.nodes.map((node) => node.maxAttempts)).toEqual([1, 1]);
  });

  it.each(['completed', 'rework'])('edits a review %s edge to rework without changing node budgets', async (sourcePort) => {
    const graph: TeamGraphSnapshotRecord = {
      ...workGraph,
      nodes: [
        ...workGraph.nodes,
        { nodeId: 'review-1', kind: 'review', title: 'Review', roleId: 'reviewer', maxAttempts: 1 },
      ],
      edges: [{ edgeId: 'edge-1', sourceNodeId: 'review-1', targetNodeId: 'work-1', sourcePort, targetPort: 'input', action: sourcePort === 'rework' ? 'rework' : 'activate' }],
    };
    const patchGraph = renderCanvas(graph);
    fireEvent.click(screen.getByLabelText('Workflow edges').querySelector('g path')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('When upstream result is'), { target: { value: 'rework' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save edge' }));

    await waitFor(() => expect(patchGraph).toHaveBeenCalledWith([
      { op: 'replace_edge', edge: expect.objectContaining({ edgeId: 'edge-1', sourcePort: 'rework', action: 'rework' }) },
    ]));
    expect(graph.nodes.map((node) => node.maxAttempts)).toEqual([1, 1]);
  });

  it.each(['start', 'work', 'review', 'human_decision', 'script_review', 'join', 'end'])('preserves and explicitly edits the %s node execution budget', async (kind) => {
    const node: TeamGraphNodeRecord = {
      nodeId: 'node-1', kind, title: 'Configured node', roleId: 'builder', taskId: 'task-1', maxAttempts: 7,
      executor: { kind: 'team-role', roleId: 'builder' },
      config: kind === 'start' ? { trigger: { mode: 'cron', cron: '*/10 * * * *' } } : {},
    };
    const patchGraph = renderCanvas({ ...workGraph, nodes: [node] });
    fireEvent.click(screen.getByText('Configured node').closest('[role="button"]')!);
    let dialog = await screen.findByRole('dialog');
    const budgetInput = within(dialog).getByRole('spinbutton', { name: labels.nodeMaxAttempts });
    expect(budgetInput).toHaveValue(7);
    expect(budgetInput).toHaveAttribute('min', '1');
    expect(budgetInput).toHaveAttribute('max', '4294967295');
    expect(budgetInput).toHaveAttribute('step', '1');
    expect(budgetInput).toHaveAccessibleDescription(labels.nodeMaxAttemptsHint);
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));
    await waitFor(() => expect(patchGraph).toHaveBeenLastCalledWith([
      { op: 'replace_node', node: expect.objectContaining({ nodeId: 'node-1', kind, title: 'Renamed', maxAttempts: 7 }) },
    ]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText('Configured node').closest('[role="button"]')!);
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: labels.nodeMaxAttempts }), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));
    await waitFor(() => expect(patchGraph).toHaveBeenLastCalledWith([
      { op: 'replace_node', node: expect.objectContaining({ nodeId: 'node-1', kind, maxAttempts: 1 }) },
    ]));
    expect(patchGraph).toHaveBeenCalledTimes(2);
  });

  it.each(['work', 'start'])('rejects invalid %s budgets and accepts the u32 maximum', async (kind) => {
    const graph: TeamGraphSnapshotRecord = {
      ...workGraph,
      nodes: [{ ...workGraph.nodes[0]!, kind, config: kind === 'start' ? { trigger: { mode: 'cron', cron: '*/10 * * * *' } } : {} }],
    };
    const patchGraph = renderCanvas(graph);
    fireEvent.click(screen.getAllByText('Work')[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    const budgetInput = within(dialog).getByRole('spinbutton', { name: labels.nodeMaxAttempts });
    const save = within(dialog).getByRole('button', { name: 'Save node' });
    for (const value of ['', '0', '-1', '1.5', '1e2', '4294967296']) {
      fireEvent.change(budgetInput, { target: { value } });
      fireEvent.click(save);
      expect(within(dialog).getByRole('alert')).toHaveTextContent(labels.nodeMaxAttemptsInvalid);
      expect(patchGraph).not.toHaveBeenCalled();
    }
    fireEvent.change(budgetInput, { target: { value: '4294967295' } });
    fireEvent.click(save);
    await waitFor(() => expect(patchGraph).toHaveBeenCalledWith([
      { op: 'replace_node', node: expect.objectContaining({ kind, maxAttempts: 4294967295 }) },
    ]));
  });

  it('shows actionable localized guidance for an exhausted rework path', async () => {
    renderCanvas({ ...workGraph, nodes: [{ ...workGraph.nodes[0]!, status: 'failed', statusReason: 'rework_limit_exceeded' }] });
    fireEvent.click(screen.getAllByText('Work')[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent(labels.reworkLimitExceeded);
    expect(within(dialog).queryByText('rework_limit_exceeded')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('spinbutton', { name: labels.nodeMaxAttempts })).toHaveValue(1);
  });

  it('does not expose an unknown status reason as raw user-facing copy', async () => {
    renderCanvas({ ...workGraph, nodes: [{ ...workGraph.nodes[0]!, status: 'failed', statusReason: 'unknown_reason' }] });
    fireEvent.click(screen.getAllByText('Work')[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('unknown_reason')).not.toBeInTheDocument();
  });

  it('edits join title and edge payload policy', async () => {
    const graph: TeamGraphSnapshotRecord = {
      ...workGraph,
      nodes: [
        ...workGraph.nodes,
        { nodeId: 'join-1', kind: 'join', title: 'Join', groupId: 'group-1', join: { requireCompleted: true, allowFailed: false, retryLimit: 1 }, maxAttempts: 1 },
      ],
      edges: [{ edgeId: 'edge-1', sourceNodeId: 'work-1', targetNodeId: 'join-1', sourcePort: 'completed', targetPort: 'input', action: 'activate', payload: { includeUpstreamResult: true } }],
    };
    const patchGraph = renderCanvas(graph);
    fireEvent.click(screen.getAllByText('Join')[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Merge' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));
    await waitFor(() => expect(patchGraph).toHaveBeenCalledWith([
      {
        op: 'replace_node',
        node: expect.objectContaining({ nodeId: 'join-1', kind: 'join', title: 'Merge', groupId: 'group-1' }),
      },
    ]));

    fireEvent.click(screen.getByLabelText('Workflow edges').querySelector('g path')!);
    const edgeDialog = await screen.findByRole('dialog');
    fireEvent.click(within(edgeDialog).getByLabelText('Include upstream result'));
    fireEvent.click(within(edgeDialog).getByRole('button', { name: 'Save edge' }));
    await waitFor(() => expect(patchGraph).toHaveBeenLastCalledWith([
      {
        op: 'replace_edge',
        edge: expect.objectContaining({ edgeId: 'edge-1', payload: { includeUpstreamResult: false } }),
      },
    ]));

  });
});
