import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';
import type { TaskManagerService } from '../../tasks/service';

export const TASK_CONTROL_CAPABILITY_ID = 'task.control';

export const taskControlCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'tasks.output', title: 'Read background task output' },
  { id: 'tasks.stop', title: 'Stop background task' },
] as const;

export function createTaskControlCapabilityOperationRoutes(deps: {
  taskService: Pick<TaskManagerService, 'output' | 'stop'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: TASK_CONTROL_CAPABILITY_ID,
      operationId: 'tasks.output',
      handle: (context) => deps.taskService.output(context.input),
    },
    {
      capabilityId: TASK_CONTROL_CAPABILITY_ID,
      operationId: 'tasks.stop',
      handle: (context) => deps.taskService.stop(context.input),
    },
  ];
}
