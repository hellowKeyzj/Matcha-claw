import { badRequest } from '../../common/application-response';
import {
  sessionIdentitiesEqual,
  validateSessionIdentity,
  type SessionIdentity,
} from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute, CapabilityOperationContext } from '../contracts/capability-router';
import type { TaskManagerService } from '../../tasks/service';

export const TOOL_INVOKE_CAPABILITY_ID = 'tool.invoke';

export const toolInvokeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'tools.invoke', title: 'Invoke tool', targetKind: 'tool' },
] as const;

export function createToolInvokeCapabilityOperationRoutes(deps: {
  taskService: TaskManagerService;
}): readonly CapabilityOperationRoute[] {
  return [{
    capabilityId: TOOL_INVOKE_CAPABILITY_ID,
    operationId: 'tools.invoke',
    handle: (context) => {
      const targetError = validateToolInvokeTargetInput(context);
      return targetError ? badRequest(targetError) : deps.taskService.invokeTool(context.input);
    },
  }];
}

function validateToolInvokeTargetInput(context: CapabilityOperationContext): string | null {
  if (context.target?.kind !== 'tool') {
    return 'Capability target kind must be tool';
  }
  const method = readString(context.domainInput.method);
  if (!method) {
    return 'Capability input method is required';
  }
  if (context.target.toolName !== method) {
    return 'Capability target toolName must match input method';
  }
  if (context.scope.kind === 'session' && !targetIdentityMatches(context.target.identity, context.scope.identity)) {
    return 'Capability target identity must match request scope';
  }
  if (context.domainInput.sessionIdentity !== undefined && !targetIdentityMatches(context.target.identity, context.domainInput.sessionIdentity)) {
    return 'Capability target identity must match input sessionIdentity';
  }
  return null;
}

function targetIdentityMatches(targetIdentity: unknown, inputIdentity: unknown): boolean {
  if (validateSessionIdentity(targetIdentity) || validateSessionIdentity(inputIdentity)) {
    return false;
  }
  return sessionIdentitiesEqual(targetIdentity as SessionIdentity, inputIdentity as SessionIdentity);
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}
