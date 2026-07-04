import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  buildTeamGraphDefinitionFromWorkflowPlan,
  buildTeamGraphIndex,
  type TeamGraphDefinition,
  type TeamGraphWorkflowPlanInput,
} from '../../runtime-host/application/team-runtime/graph/index';
import { createInitialTeamGraphRunState, reduceTeamGraphRunState } from '../../runtime-host/application/team-runtime/graph/reducer';
import { buildTeamGraphSnapshotProjection } from '../../runtime-host/application/team-runtime/graph/projection';
import { exportTeamGraphDefinitionYaml, parseTeamGraphDefinitionYaml } from '../../runtime-host/application/team-runtime/graph/export-yaml';
import { scheduleReadyWorkNodeDeliveries } from '../../runtime-host/application/team-runtime/graph/scheduler';

function buildWorkflowPlan(): TeamGraphWorkflowPlanInput {
  return {
    workflowPlanId: 'plan-1',
    runId: 'run-1',
    title: 'Graph plan',
    status: 'planned',
    idempotencyKey: 'plan-1',
    createdAt: 100,
    groups: [{ groupId: 'group-1', title: 'Main', taskIds: ['task-a', 'task-b'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
    tasks: [
      { taskId: 'task-a', roleId: 'operator', title: 'Task A', prompt: 'Do A' },
      { taskId: 'task-b', roleId: 'operator', title: 'Task B', prompt: 'Do B', dependsOnTaskIds: ['task-a'], outputArtifactKind: 'report' },
    ],
  };
}

function buildReviewLoopDefinition(): TeamGraphDefinition {
  return {
    graphId: 'graph-1',
    workflowPlanId: 'plan-1',
    runId: 'run-1',
    title: 'Review loop',
    status: 'planned',
    idempotencyKey: 'graph-1',
    createdAt: 100,
    groups: [],
    nodes: [
      {
        nodeId: 'draft',
        nodeKind: 'work',
        kind: 'work',
        taskId: 'draft',
        roleId: 'operator',
        title: 'Draft',
        executor: { kind: 'team-role', roleId: 'operator' },
        config: { prompt: 'Draft' },
        metadata: { workflowPlanId: 'plan-1', runId: 'run-1', taskId: 'draft', roleId: 'operator', title: 'Draft' },
      },
      { nodeId: 'review', nodeKind: 'review', kind: 'review', title: 'Review', metadata: { workflowPlanId: 'plan-1', runId: 'run-1', title: 'Review' } },
      {
        nodeId: 'rework',
        nodeKind: 'work',
        kind: 'work',
        taskId: 'rework',
        roleId: 'operator',
        title: 'Rework',
        executor: { kind: 'team-role', roleId: 'operator' },
        config: { prompt: 'Rework' },
        metadata: { workflowPlanId: 'plan-1', runId: 'run-1', taskId: 'rework', roleId: 'operator', title: 'Rework' },
      },
      {
        nodeId: 'publish',
        nodeKind: 'work',
        kind: 'work',
        taskId: 'publish',
        roleId: 'operator',
        title: 'Publish',
        executor: { kind: 'team-role', roleId: 'operator' },
        config: { prompt: 'Publish' },
        metadata: { workflowPlanId: 'plan-1', runId: 'run-1', taskId: 'publish', roleId: 'operator', title: 'Publish' },
      },
    ],
    edges: [
      { edgeId: 'draft-review', sourceNodeId: 'draft', targetNodeId: 'review', kind: 'completed', type: 'completed', sourcePort: 'completed', targetPort: 'input', action: 'activate', payload: { includeUpstreamResult: true }, metadata: {} },
      { edgeId: 'review-rework', sourceNodeId: 'review', targetNodeId: 'rework', kind: 'failed', type: 'failed', sourcePort: 'failed', targetPort: 'input', action: 'rework', payload: { includeUpstreamResult: true }, metadata: {} },
      { edgeId: 'review-publish', sourceNodeId: 'review', targetNodeId: 'publish', kind: 'passed', type: 'passed', sourcePort: 'passed', targetPort: 'input', action: 'activate', payload: { includeUpstreamResult: true }, metadata: {} },
    ],
  };
}

function buildArmedStartDefinition(): TeamGraphDefinition {
  return {
    graphId: 'graph-trigger',
    workflowPlanId: 'plan-trigger',
    runId: 'run-1',
    title: 'Triggered graph',
    status: 'planned',
    idempotencyKey: 'graph-trigger',
    createdAt: 100,
    groups: [],
    nodes: [
      { nodeId: 'start', nodeKind: 'start', kind: 'start', title: 'Start', config: { trigger: { mode: 'webhook', path: '/incoming' } }, metadata: { workflowPlanId: 'plan-trigger', runId: 'run-1', title: 'Start' } },
      {
        nodeId: 'work',
        nodeKind: 'work',
        kind: 'work',
        taskId: 'work',
        roleId: 'operator',
        title: 'Work',
        executor: { kind: 'team-role', roleId: 'operator' },
        config: { prompt: 'Work' },
        metadata: { workflowPlanId: 'plan-trigger', runId: 'run-1', taskId: 'work', roleId: 'operator', title: 'Work' },
      },
      { nodeId: 'end', nodeKind: 'end', kind: 'end', title: 'End', metadata: { workflowPlanId: 'plan-trigger', runId: 'run-1', title: 'End' } },
    ],
    edges: [
      { edgeId: 'start-work', sourceNodeId: 'start', targetNodeId: 'work', kind: 'completed', type: 'completed', sourcePort: 'completed', targetPort: 'input', action: 'activate', payload: { includeUpstreamResult: true }, metadata: {} },
      { edgeId: 'work-end', sourceNodeId: 'work', targetNodeId: 'end', kind: 'completed', type: 'completed', sourcePort: 'completed', targetPort: 'input', action: 'finish', payload: { includeUpstreamResult: true }, metadata: {} },
    ],
  };
}

function buildParallelWorkDefinition(): TeamGraphDefinition {
  return {
    graphId: 'graph-parallel-work',
    workflowPlanId: 'plan-parallel-work',
    runId: 'run-1',
    title: 'Parallel work graph',
    status: 'planned',
    idempotencyKey: 'graph-parallel-work',
    createdAt: 100,
    groups: [],
    nodes: [
      {
        nodeId: 'a',
        nodeKind: 'work',
        kind: 'work',
        taskId: 'a',
        roleId: 'operator',
        title: 'A',
        executor: { kind: 'team-role', roleId: 'operator' },
        config: { prompt: 'A' },
        metadata: { workflowPlanId: 'plan-parallel-work', runId: 'run-1', taskId: 'a', roleId: 'operator', title: 'A' },
      },
      {
        nodeId: 'b',
        nodeKind: 'work',
        kind: 'work',
        taskId: 'b',
        roleId: 'operator',
        title: 'B',
        executor: { kind: 'team-role', roleId: 'operator' },
        config: { prompt: 'B' },
        metadata: { workflowPlanId: 'plan-parallel-work', runId: 'run-1', taskId: 'b', roleId: 'operator', title: 'B' },
      },
      {
        nodeId: 'c',
        nodeKind: 'work',
        kind: 'work',
        taskId: 'c',
        roleId: 'reviewer',
        title: 'C',
        executor: { kind: 'team-role', roleId: 'reviewer' },
        config: { prompt: 'C' },
        metadata: { workflowPlanId: 'plan-parallel-work', runId: 'run-1', taskId: 'c', roleId: 'reviewer', title: 'C' },
      },
    ],
    edges: [],
  };
}

function buildParallelAgentReviewDefinition(): TeamGraphDefinition {
  return {
    graphId: 'graph-parallel-review',
    workflowPlanId: 'plan-parallel-review',
    runId: 'run-1',
    title: 'Parallel review graph',
    status: 'planned',
    idempotencyKey: 'graph-parallel-review',
    createdAt: 100,
    groups: [],
    nodes: [
      {
        nodeId: 'review-a',
        nodeKind: 'review',
        kind: 'review',
        title: 'Review A',
        executor: { kind: 'team-role', roleId: 'reviewer' },
        metadata: { workflowPlanId: 'plan-parallel-review', runId: 'run-1', title: 'Review A' },
      },
      {
        nodeId: 'review-b',
        nodeKind: 'review',
        kind: 'review',
        title: 'Review B',
        executor: { kind: 'team-role', roleId: 'reviewer' },
        metadata: { workflowPlanId: 'plan-parallel-review', runId: 'run-1', title: 'Review B' },
      },
    ],
    edges: [],
  };
}

function buildJoinDefinition(): TeamGraphDefinition {
  return {
    graphId: 'graph-join',
    workflowPlanId: 'plan-join',
    runId: 'run-1',
    title: 'Join graph',
    status: 'planned',
    idempotencyKey: 'graph-join',
    createdAt: 100,
    groups: [],
    nodes: [
      {
        nodeId: 'a',
        nodeKind: 'work',
        kind: 'work',
        taskId: 'a',
        roleId: 'operator',
        title: 'A',
        executor: { kind: 'team-role', roleId: 'operator' },
        config: { prompt: 'A' },
        metadata: { workflowPlanId: 'plan-join', runId: 'run-1', taskId: 'a', roleId: 'operator', title: 'A' },
      },
      {
        nodeId: 'b',
        nodeKind: 'work',
        kind: 'work',
        taskId: 'b',
        roleId: 'operator',
        title: 'B',
        executor: { kind: 'team-role', roleId: 'operator' },
        config: { prompt: 'B' },
        metadata: { workflowPlanId: 'plan-join', runId: 'run-1', taskId: 'b', roleId: 'operator', title: 'B' },
      },
      { nodeId: 'join', nodeKind: 'join', kind: 'join', title: 'Join', metadata: { workflowPlanId: 'plan-join', runId: 'run-1', title: 'Join' } },
      { nodeId: 'end', nodeKind: 'end', kind: 'end', title: 'End', metadata: { workflowPlanId: 'plan-join', runId: 'run-1', title: 'End' } },
    ],
    edges: [
      { edgeId: 'a-join', sourceNodeId: 'a', targetNodeId: 'join', kind: 'completed', type: 'completed', sourcePort: 'completed', targetPort: 'input', action: 'gate', payload: { includeUpstreamResult: true }, metadata: {} },
      { edgeId: 'b-join', sourceNodeId: 'b', targetNodeId: 'join', kind: 'completed', type: 'completed', sourcePort: 'completed', targetPort: 'input', action: 'gate', payload: { includeUpstreamResult: true }, metadata: {} },
      { edgeId: 'join-end', sourceNodeId: 'join', targetNodeId: 'end', kind: 'joined', type: 'joined', sourcePort: 'joined', targetPort: 'input', action: 'finish', payload: { includeUpstreamResult: true }, metadata: {} },
    ],
  };
}

describe('TeamRun graph core', () => {
  it('maps workflow tasks to WorkNodes and dependency edges with executor and config', () => {
    const definition = buildTeamGraphDefinitionFromWorkflowPlan(buildWorkflowPlan());

    expect(definition.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'workflow-task:task-a',
        taskId: 'task-a',
        executor: { kind: 'team-role', roleId: 'operator' },
        config: { prompt: 'Do A' },
      }),
      expect.objectContaining({
        nodeId: 'workflow-task:task-b',
        config: { prompt: 'Do B', outputArtifactKind: 'report' },
      }),
    ]));
    expect(definition.edges).toEqual([expect.objectContaining({
      edgeId: 'workflow-task-dependency:task-a:task-b',
      sourceNodeId: 'workflow-task:task-a',
      targetNodeId: 'workflow-task:task-b',
    })]);
  });

  it('indexes graph fan-out and projects edge status from run state', () => {
    const definition = buildTeamGraphDefinitionFromWorkflowPlan(buildWorkflowPlan());
    const index = buildTeamGraphIndex(definition);
    const state = reduceTeamGraphRunState(createInitialTeamGraphRunState({ definition, nowMs: 200 }), {
      type: 'task.completed',
      taskId: 'task-a',
      completedAt: 300,
    });
    const snapshot = buildTeamGraphSnapshotProjection(state);

    expect(index.outEdgesByNode.get('workflow-task:task-a')?.map((edge) => edge.targetNodeId)).toEqual(['workflow-task:task-b']);
    expect(snapshot.edges).toEqual([expect.objectContaining({ edgeId: 'workflow-task-dependency:task-a:task-b', status: 'satisfied' })]);
    expect(snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'workflow-task:task-b', config: expect.objectContaining({ outputArtifactKind: 'report' }) }),
    ]));
  });

  it('routes failed review output through failed port without completing the review node', () => {
    const definition = buildReviewLoopDefinition();
    const firstState = reduceTeamGraphRunState(createInitialTeamGraphRunState({ definition, nowMs: 100 }), {
      type: 'task.completed',
      taskId: 'draft',
      completedAt: 200,
    });
    const failedReviewState = reduceTeamGraphRunState(firstState, {
      type: 'node.failed',
      nodeId: 'review',
      failedAt: 300,
      outputPort: 'failed',
    });

    expect(failedReviewState.completedNodeIds).not.toContain('review');
    expect(failedReviewState.completedNodeOutputPortsByNodeId?.review).toEqual(['failed']);
    expect(failedReviewState.nodeExecutionsByNodeId.rework?.attempts.at(-1)?.status).toBe('ready');
    expect(failedReviewState.nodeExecutionsByNodeId.publish?.attempts.at(-1)?.status).toBe('pending');
  });

  it('keeps armed StartNodes pending until their trigger fires', () => {
    const definition = buildArmedStartDefinition();
    const initialState = createInitialTeamGraphRunState({ definition, nowMs: 100 });
    const triggered = reduceTeamGraphRunState(initialState, { type: 'trigger.fired', nodeId: 'start', firedAt: 200, metadata: { triggerSource: 'webhook' } });

    expect(initialState.nodeExecutionsByNodeId.start?.attempts.at(-1)?.status).toBe('pending');
    expect(initialState.readyQueue).toEqual([]);
    expect(triggered.nodeExecutionsByNodeId.start?.attempts.at(-1)?.status).toBe('ready');
    expect(triggered.readyQueue).toEqual(['start']);
  });

  it('restarts reachable downstream nodes when an armed StartNode fires again', () => {
    const definition = buildArmedStartDefinition();
    const firstRunCompleted = reduceTeamGraphRunState(reduceTeamGraphRunState(reduceTeamGraphRunState(reduceTeamGraphRunState(
      createInitialTeamGraphRunState({ definition, nowMs: 100 }),
      { type: 'trigger.fired', nodeId: 'start', firedAt: 200 },
    ), {
      type: 'node.completed', nodeId: 'start', completedAt: 210, outputPort: 'completed',
    }), {
      type: 'task.completed', taskId: 'work', completedAt: 300,
    }), {
      type: 'node.completed', nodeId: 'end', completedAt: 400, outputPort: 'completed',
    });
    const secondTriggered = reduceTeamGraphRunState(firstRunCompleted, { type: 'trigger.fired', nodeId: 'start', firedAt: 500 });

    expect(firstRunCompleted.completedNodeIds).toEqual(['start', 'work', 'end']);
    expect(secondTriggered.completedNodeIds).toEqual([]);
    expect(secondTriggered.readyQueue).toEqual(['start']);
    expect(secondTriggered.nodeExecutionsByNodeId.start?.attempts.at(-1)?.status).toBe('ready');
    expect(secondTriggered.nodeExecutionsByNodeId.work?.attempts.at(-1)?.status).toBe('pending');
    expect(secondTriggered.nodeExecutionsByNodeId.end?.attempts.at(-1)?.status).toBe('pending');
    expect(secondTriggered.nodeExecutionsByNodeId.work?.attempts).toHaveLength(2);
    expect(secondTriggered.nodeExecutionsByNodeId.end?.attempts).toHaveLength(2);
  });

  it('schedules only one ready WorkNode per active role session', () => {
    const definition = buildParallelWorkDefinition();
    const scheduled = scheduleReadyWorkNodeDeliveries(createInitialTeamGraphRunState({ definition, nowMs: 100 }), {
      maxDeliveries: 3,
      maxActiveRoleSessions: 3,
      roleSessionKeyByRoleId: { operator: 'session:operator', reviewer: 'session:reviewer' },
      nowMs: 200,
    });

    expect(scheduled.deliveries.map((delivery) => delivery.nodeId)).toEqual(['a', 'c']);
    expect(scheduled.state.readyQueue).toEqual(['b']);
    expect(scheduled.state.nodeExecutionsByNodeId.a?.attempts.at(-1)?.status).toBe('running');
    expect(scheduled.state.nodeExecutionsByNodeId.b?.attempts.at(-1)?.status).toBe('ready');
    expect(scheduled.state.nodeExecutionsByNodeId.c?.attempts.at(-1)?.status).toBe('running');
  });

  it('stops scanning ready queue items once delivery capacity is full', () => {
    const definition = buildParallelWorkDefinition();
    const initialState = createInitialTeamGraphRunState({ definition, nowMs: 100 });
    const scheduled = scheduleReadyWorkNodeDeliveries({
      ...initialState,
      readyQueueItems: [
        ...initialState.readyQueueItems,
        initialState.readyQueueItems[1]!,
      ],
    }, {
      maxDeliveries: 1,
      maxActiveRoleSessions: 1,
      roleSessionKeyByRoleId: { operator: 'session:operator', reviewer: 'session:reviewer' },
      nowMs: 200,
    });

    expect(scheduled.deliveries.map((delivery) => delivery.nodeId)).toEqual(['a']);
    expect(scheduled.state.readyQueue).toEqual(['b', 'c', 'b']);
  });

  it('keeps ready agent ReviewNodes queued while their reviewer session is active', () => {
    const definition = buildParallelAgentReviewDefinition();
    const scheduled = scheduleReadyWorkNodeDeliveries(createInitialTeamGraphRunState({ definition, nowMs: 100 }), {
      maxDeliveries: 3,
      maxActiveRoleSessions: 3,
      activeRoleSessionKeys: ['session:reviewer'],
      roleSessionKeyByRoleId: { reviewer: 'session:reviewer' },
      nowMs: 200,
    });

    expect(scheduled.deliveries).toEqual([]);
    expect(scheduled.controlEffects).toEqual([]);
    expect(scheduled.state.readyQueue).toEqual(['review-a', 'review-b']);
    expect(scheduled.state.nodeExecutionsByNodeId['review-a']?.attempts.at(-1)?.status).toBe('ready');
    expect(scheduled.state.nodeExecutionsByNodeId['review-b']?.attempts.at(-1)?.status).toBe('ready');
  });

  it('waits for all gate inputs before readying a join node', () => {
    const definition = buildJoinDefinition();
    const initialState = createInitialTeamGraphRunState({ definition, nowMs: 100 });
    const firstCompleted = reduceTeamGraphRunState(initialState, {
      type: 'task.completed',
      taskId: 'a',
      completedAt: 200,
    });
    const joined = reduceTeamGraphRunState(reduceTeamGraphRunState(firstCompleted, {
      type: 'task.completed',
      taskId: 'b',
      completedAt: 300,
    }), {
      type: 'node.completed',
      nodeId: 'join',
      completedAt: 400,
      outputPort: 'joined',
    });

    expect(firstCompleted.nodeExecutionsByNodeId.join?.attempts.at(-1)?.status).toBe('pending');
    expect(joined.nodeExecutionsByNodeId.join?.attempts.at(-1)?.status).toBe('completed');
    expect(joined.nodeExecutionsByNodeId.end?.attempts.at(-1)?.status).toBe('ready');
  });

  it('exports deterministic TeamRun graph YAML as a topology projection without execution history', () => {
    const { fileName, yaml } = exportTeamGraphDefinitionYaml({
      ...buildArmedStartDefinition(),
      title: 'Triggered: graph?',
      metadata: { layout: 'manual' },
      nodes: buildArmedStartDefinition().nodes.map((node) => ({
        ...node,
        metadata: { ...node.metadata, position: { x: 10, y: 20 } },
      })),
    });
    const parsed = parseYaml(yaml) as {
      version: number;
      runId: string;
      workflowPlanId: string;
      status: string;
      nodes: Array<{ id: string; kind: string; metadata?: { position?: { x: number; y: number } } & Record<string, unknown> }>;
      edges: Array<{ id: string; from: string; to: string }>;
      metadata?: Record<string, unknown>;
      nodeExecutions?: unknown;
      nodeDeliveries?: unknown;
    };

    expect(fileName).toBe('Triggered- graph.yaml');
    expect(parsed).toEqual(expect.objectContaining({
      version: 1,
      runId: 'run-1',
      workflowPlanId: 'plan-trigger',
      status: 'planned',
      metadata: { layout: 'manual' },
    }));
    expect(parsed.nodes.map((node) => node.id)).toEqual(['start', 'work', 'end']);
    expect(parsed.nodes[0]?.metadata).toEqual({ workflowPlanId: 'plan-trigger', runId: 'run-1', title: 'Start', position: { x: 10, y: 20 } });
    expect(parsed.edges).toEqual([
      expect.objectContaining({ id: 'start-work', from: 'start', to: 'work' }),
      expect.objectContaining({ id: 'work-end', from: 'work', to: 'end' }),
    ]);
    expect(parsed.nodeExecutions).toBeUndefined();
    expect(parsed.nodeDeliveries).toBeUndefined();
  });

  it('parses exported TeamRun graph YAML into the graph save shape', () => {
    const { yaml } = exportTeamGraphDefinitionYaml({
      ...buildArmedStartDefinition(),
      nodes: buildArmedStartDefinition().nodes.map((node) => ({
        ...node,
        metadata: { ...node.metadata, position: { x: 10, y: 20 } },
      })),
    });
    const parsed = parseTeamGraphDefinitionYaml(yaml);

    expect(parsed).toEqual(expect.objectContaining({
      graphId: 'graph-trigger',
      runId: 'run-1',
      workflowPlanId: 'plan-trigger',
      title: 'Triggered graph',
      status: 'planned',
      nodes: [
        expect.objectContaining({ nodeId: 'start', kind: 'start', title: 'Start', metadata: expect.objectContaining({ position: { x: 10, y: 20 } }) }),
        expect.objectContaining({ nodeId: 'work', kind: 'work', roleId: 'operator', taskId: 'work' }),
        expect.objectContaining({ nodeId: 'end', kind: 'end', title: 'End' }),
      ],
      edges: [
        expect.objectContaining({ edgeId: 'start-work', sourceNodeId: 'start', targetNodeId: 'work', action: 'activate' }),
        expect.objectContaining({ edgeId: 'work-end', sourceNodeId: 'work', targetNodeId: 'end', action: 'finish' }),
      ],
    }));
  });
});
