import type {
  TeamGraphDefinition,
  TeamGraphEdgeDefinition,
  TeamGraphWorkflowGroupInput,
  TeamGraphWorkflowJoinPolicyInput,
  TeamGraphWorkflowPlanInput,
  TeamGraphWorkflowTaskInput,
  TeamGraphNodeDefinition,
  TeamGraphWorkNodeDefinition,
} from './definition';

export type {
  TeamGraphDefinition,
  TeamGraphEdgeDefinition,
  TeamGraphWorkflowGroupInput,
  TeamGraphWorkflowJoinPolicyInput,
  TeamGraphWorkflowPlanInput,
  TeamGraphWorkflowTaskInput,
  TeamGraphNodeDefinition,
  TeamGraphWorkNodeDefinition,
} from './definition';

export interface TeamGraphIndex {
  readonly nodesById: ReadonlyMap<string, TeamGraphNodeDefinition>;
  readonly outEdgesByNode: ReadonlyMap<string, readonly TeamGraphEdgeDefinition[]>;
  readonly inEdgesByNode: ReadonlyMap<string, readonly TeamGraphEdgeDefinition[]>;
}

export function buildTeamGraphDefinitionFromWorkflowPlan(plan: TeamGraphWorkflowPlanInput): TeamGraphDefinition {
  const tasksById = buildTasksById(plan.tasks);
  const groupMembershipByTaskId = buildGroupMembershipByTaskId(plan.groups, tasksById);
  const nodes = plan.tasks.map((task) => buildWorkNodeDefinition(plan, task, groupMembershipByTaskId.get(task.taskId)));
  const edges = buildDependencyEdges(plan.tasks, tasksById);

  return {
    graphId: `workflow-plan:${plan.workflowPlanId}`,
    workflowPlanId: plan.workflowPlanId,
    runId: plan.runId,
    title: plan.title,
    status: plan.status,
    idempotencyKey: plan.idempotencyKey,
    createdAt: plan.createdAt,
    nodes,
    edges,
    groups: plan.groups.map((group) => ({
      groupId: group.groupId,
      title: group.title,
      taskIds: [...group.taskIds],
      join: cloneJoinPolicy(group.join),
    })),
  };
}

export function buildTeamGraphIndex(definition: TeamGraphDefinition): TeamGraphIndex {
  const nodesById = new Map<string, TeamGraphNodeDefinition>();
  const outEdgesByNode = new Map<string, TeamGraphEdgeDefinition[]>();
  const inEdgesByNode = new Map<string, TeamGraphEdgeDefinition[]>();

  for (const node of definition.nodes) {
    nodesById.set(node.nodeId, node);
    outEdgesByNode.set(node.nodeId, []);
    inEdgesByNode.set(node.nodeId, []);
  }

  for (const edge of definition.edges) {
    pushEdge(outEdgesByNode, edge.sourceNodeId, edge);
    pushEdge(inEdgesByNode, edge.targetNodeId, edge);
  }

  return { nodesById, outEdgesByNode, inEdgesByNode };
}

function buildTasksById(tasks: readonly TeamGraphWorkflowTaskInput[]): Map<string, TeamGraphWorkflowTaskInput> {
  const tasksById = new Map<string, TeamGraphWorkflowTaskInput>();
  for (const task of tasks) {
    if (tasksById.has(task.taskId)) {
      throw new Error(`Duplicate workflow taskId "${task.taskId}". Give each workflow task a unique taskId before building the TeamRun graph.`);
    }
    tasksById.set(task.taskId, task);
  }
  return tasksById;
}

interface TeamGraphTaskGroupMembership {
  readonly groupId: string;
  readonly groupTitle: string;
  readonly groupJoin: TeamGraphWorkflowJoinPolicyInput;
}

function buildGroupMembershipByTaskId(
  groups: readonly TeamGraphWorkflowGroupInput[],
  tasksById: ReadonlyMap<string, TeamGraphWorkflowTaskInput>,
): Map<string, TeamGraphTaskGroupMembership> {
  const groupMembershipByTaskId = new Map<string, TeamGraphTaskGroupMembership>();
  for (const group of groups) {
    for (const taskId of group.taskIds) {
      if (!tasksById.has(taskId)) {
        throw new Error(`Workflow group "${group.groupId}" references unknown taskId "${taskId}". Add the task to plan.tasks or remove it from the group taskIds.`);
      }
      groupMembershipByTaskId.set(taskId, {
        groupId: group.groupId,
        groupTitle: group.title,
        groupJoin: cloneJoinPolicy(group.join),
      });
    }
  }
  return groupMembershipByTaskId;
}

function buildWorkNodeDefinition(
  plan: TeamGraphWorkflowPlanInput,
  task: TeamGraphWorkflowTaskInput,
  groupMembership: TeamGraphTaskGroupMembership | undefined,
): TeamGraphWorkNodeDefinition {
  return {
    nodeId: buildWorkflowTaskNodeId(task.taskId),
    nodeKind: 'work',
    kind: 'work',
    taskId: task.taskId,
    roleId: task.roleId,
    title: task.title,
    ...(groupMembership ? { groupId: groupMembership.groupId } : {}),
    executor: { kind: 'team-role', roleId: task.roleId },
    config: {
      prompt: task.prompt,
      ...(task.outputArtifactKind ? { outputArtifactKind: task.outputArtifactKind } : {}),
    },
    metadata: {
      workflowPlanId: plan.workflowPlanId,
      runId: plan.runId,
      taskId: task.taskId,
      roleId: task.roleId,
      title: task.title,
      ...(groupMembership ? {
        groupId: groupMembership.groupId,
        groupTitle: groupMembership.groupTitle,
        groupJoin: groupMembership.groupJoin,
      } : {}),
      ...(task.outputArtifactKind ? { outputArtifactKind: task.outputArtifactKind } : {}),
    },
  };
}

function buildDependencyEdges(
  tasks: readonly TeamGraphWorkflowTaskInput[],
  tasksById: ReadonlyMap<string, TeamGraphWorkflowTaskInput>,
): TeamGraphEdgeDefinition[] {
  const edges: TeamGraphEdgeDefinition[] = [];
  for (const task of tasks) {
    for (const dependencyTaskId of task.dependsOnTaskIds ?? []) {
      if (!tasksById.has(dependencyTaskId)) {
        throw new Error(`Workflow task "${task.taskId}" depends on unknown taskId "${dependencyTaskId}". Add the dependency task to plan.tasks or remove it from dependsOnTaskIds.`);
      }
      edges.push({
        edgeId: `workflow-task-dependency:${dependencyTaskId}:${task.taskId}`,
        sourceNodeId: buildWorkflowTaskNodeId(dependencyTaskId),
        targetNodeId: buildWorkflowTaskNodeId(task.taskId),
        kind: 'completed_success',
        type: 'completed_success',
        sourcePort: 'completed',
        targetPort: 'input',
        action: 'activate',
        payload: { includeUpstreamResult: true },
        metadata: { dependencyTaskId, taskId: task.taskId },
      });
    }
  }
  return edges;
}

function pushEdge(edgesByNode: Map<string, TeamGraphEdgeDefinition[]>, nodeId: string, edge: TeamGraphEdgeDefinition): void {
  const edges = edgesByNode.get(nodeId);
  if (edges) {
    edges.push(edge);
    return;
  }
  edgesByNode.set(nodeId, [edge]);
}

function buildWorkflowTaskNodeId(taskId: string): string {
  return `workflow-task:${taskId}`;
}

function cloneJoinPolicy(join: TeamGraphWorkflowJoinPolicyInput): TeamGraphWorkflowJoinPolicyInput {
  return {
    requireCompleted: join.requireCompleted,
    allowFailed: join.allowFailed,
    retryLimit: join.retryLimit,
  };
}
