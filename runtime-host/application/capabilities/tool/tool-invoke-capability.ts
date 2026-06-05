import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';
import type { TaskManagerService } from '../../tasks/service';

export const TOOL_INVOKE_CAPABILITY_ID = 'tool.invoke';

export const toolInvokeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'tools.invoke', title: 'Invoke tool' },
] as const;

export function createToolInvokeCapabilityOperationRoutes(deps: {
  taskService: TaskManagerService;
}): readonly CapabilityOperationRoute[] {
  return [{
    capabilityId: TOOL_INVOKE_CAPABILITY_ID,
    operationId: 'tools.invoke',
    handle: (context) => deps.taskService.invokeTool(context.input),
  }];
}
