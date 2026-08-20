import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TeamRunGraphCanvas } from '@/pages/Teams/TeamRunGraphCanvas';
import type { TeamGraphSnapshotRecord } from '@/services/team-types';

const labels = {
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

function renderCanvas(graph: TeamGraphSnapshotRecord, onSaveGraph = vi.fn().mockResolvedValue(undefined)) {
  render(<TeamRunGraphCanvas graph={graph} emptyLabel="Empty" titleLabel="Run graph" executorLabel="Executor" labels={labels} onSaveGraph={onSaveGraph} />);
  return onSaveGraph;
}

const workGraph: TeamGraphSnapshotRecord = {
  graphId: 'graph-1', workflowPlanId: 'plan-1', runId: 'run-1', title: 'Graph',
  nodes: [{ nodeId: 'work-1', kind: 'work', title: 'Work', roleId: 'builder', taskId: 'task-1', maxAttempts: 1 }],
  edges: [],
};

describe('TeamRunGraphCanvas typed graph fact editors', () => {
  it('edits work prompt, executor role, artifact kind, and group without private projections', async () => {
    const saveGraph = renderCanvas(workGraph);
    fireEvent.click(screen.getAllByText('Work')[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Role ID'), { target: { value: 'reviewer' } });
    fireEvent.change(within(dialog).getByLabelText('Task ID'), { target: { value: 'task-review' } });
    fireEvent.change(within(dialog).getByLabelText('Work prompt'), { target: { value: 'Review the upstream result.' } });
    fireEvent.change(within(dialog).getByLabelText('Output artifact kind'), { target: { value: 'review-report' } });
    fireEvent.change(within(dialog).getByLabelText('Group ID'), { target: { value: 'review-group' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));

    await waitFor(() => expect(saveGraph).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({
        roleId: 'reviewer', taskId: 'task-review', prompt: 'Review the upstream result.',
        outputArtifactKind: 'review-report', groupId: 'review-group',
        executor: { kind: 'team-role', roleId: 'reviewer' },
      })],
    })));
    expect(screen.queryByText('session-ref')).not.toBeInTheDocument();
  });

  it('edits join group policy and edge payload policy', async () => {
    const graph: TeamGraphSnapshotRecord = {
      ...workGraph,
      nodes: [
        ...workGraph.nodes,
        { nodeId: 'join-1', kind: 'join', title: 'Join', groupId: 'group-1', join: { requireCompleted: true, allowFailed: false, retryLimit: 1 }, maxAttempts: 1 },
      ],
      edges: [{ edgeId: 'edge-1', sourceNodeId: 'work-1', targetNodeId: 'join-1', sourcePort: 'completed', targetPort: 'input', action: 'activate', payload: { includeUpstreamResult: true } }],
    };
    const saveGraph = renderCanvas(graph);
    fireEvent.click(screen.getAllByText('Join')[0]!.closest('[role="button"]')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Group ID'), { target: { value: 'group-merged' } });
    fireEvent.click(within(dialog).getByLabelText('Require completed upstream nodes'));
    fireEvent.click(within(dialog).getByLabelText('Allow failed upstream nodes'));
    fireEvent.change(within(dialog).getByLabelText('Join retry limit'), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save node' }));
    await waitFor(() => expect(saveGraph).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.anything(), expect.objectContaining({ groupId: 'group-merged', join: { requireCompleted: false, allowFailed: true, retryLimit: 3 } })],
    })));

    fireEvent.click(screen.getByLabelText('Workflow edges').querySelector('g path')!);
    const edgeDialog = await screen.findByRole('dialog');
    fireEvent.click(within(edgeDialog).getByLabelText('Include upstream result'));
    fireEvent.click(within(edgeDialog).getByRole('button', { name: 'Save edge' }));
    await waitFor(() => expect(saveGraph).toHaveBeenLastCalledWith(expect.objectContaining({
      edges: [expect.objectContaining({ payload: { includeUpstreamResult: false } })],
    })));

  });
});
