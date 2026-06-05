import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';
import type { MultiAgentTaskWorkflow } from '../../workflows/multi-agent-task/multi-agent-task-workflow';

export const MULTI_AGENT_TASK_CAPABILITY_ID = 'multi-agent.task';

export const multiAgentTaskCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'multiAgentTask.start', title: 'Start a multi-agent task workflow' },
] as const;

export function createMultiAgentTaskCapabilityOperationRoutes(deps: {
  multiAgentTaskWorkflow: Pick<MultiAgentTaskWorkflow, 'start'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: MULTI_AGENT_TASK_CAPABILITY_ID,
      operationId: 'multiAgentTask.start',
      handle: (context) => deps.multiAgentTaskWorkflow.start(context.input),
    },
  ];
}
