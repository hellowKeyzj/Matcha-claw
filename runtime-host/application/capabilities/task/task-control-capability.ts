import { badRequest } from '../../common/application-response';
import {
  sessionIdentitiesEqual,
  validateSessionIdentity,
  type CapabilityTarget,
  type RuntimeScope,
  type SessionIdentity,
} from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute, CapabilityOperationContext } from '../contracts/capability-router';
import type { TaskManagerService } from '../../tasks/service';

export const TASK_CONTROL_CAPABILITY_ID = 'task.control';

export const taskControlCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'tasks.output', title: 'Read background task output', targetKind: 'task' },
  { id: 'tasks.stop', title: 'Stop background task', targetKind: 'task' },
] as const;

export function createTaskControlCapabilityOperationRoutes(deps: {
  taskService: Pick<TaskManagerService, 'output' | 'stop'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: TASK_CONTROL_CAPABILITY_ID,
      operationId: 'tasks.output',
      handle: (context) => {
        const targetError = validateTaskTargetInput(context);
        return targetError ? badRequest(targetError) : deps.taskService.output(context.input);
      },
    },
    {
      capabilityId: TASK_CONTROL_CAPABILITY_ID,
      operationId: 'tasks.stop',
      handle: (context) => {
        const targetError = validateTaskTargetInput(context);
        return targetError ? badRequest(targetError) : deps.taskService.stop(context.input);
      },
    },
  ];
}

function validateTaskTargetInput(context: CapabilityOperationContext): string | null {
  if (context.target?.kind !== 'task') {
    return 'Capability target kind must be task';
  }
  if (context.domainInput.taskId !== context.target.taskId) {
    return 'Capability target taskId must match input taskId';
  }
  if (!context.target.owner) {
    return 'Capability target owner is required';
  }
  if (!taskOwnerMatchesInput(context.target.owner, context.domainInput)) {
    return 'Capability target owner must match input owner';
  }
  return taskOwnerMatchesScope(context.target.owner, context.scope)
    ? null
    : 'Capability target owner must match request scope';
}

function taskOwnerMatchesInput(owner: CapabilityTarget, input: Record<string, unknown>): boolean {
  if (owner.kind === 'session') {
    const identityError = validateSessionIdentity(input.sessionIdentity);
    return !identityError && sessionIdentitiesEqual(owner.identity, input.sessionIdentity as SessionIdentity);
  }
  if (owner.kind === 'team-run') {
    return owner.runId === readString(input.runId)
      && owner.teamId === readString(input.teamId);
  }
  return false;
}

function taskOwnerMatchesScope(owner: CapabilityTarget, scope: RuntimeScope): boolean {
  if (owner.kind === 'session') {
    return scope.kind === 'session' && sessionIdentitiesEqual(owner.identity, scope.identity);
  }
  if (owner.kind === 'team-run') {
    return scope.kind === 'team-run'
      && owner.runId === scope.runId
      && owner.teamId === scope.teamId;
  }
  return false;
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}
