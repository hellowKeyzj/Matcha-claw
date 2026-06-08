import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationContext, CapabilityOperationRoute } from '../contracts/capability-router';
import type { SessionCommandService } from '../../sessions/session-command-service';
import {
  sessionIdentitiesEqual,
  type SessionIdentity,
} from '../../agent-runtime/contracts/runtime-address';

export const SESSION_APPROVAL_CAPABILITY_ID = 'session.approval';

export const sessionApprovalCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'approvals.list', title: 'List approvals', targetKind: 'session' },
  { id: 'approvals.resolve', title: 'Resolve approval', targetKind: 'approval' },
] as const;

function badRequest(message: string) {
  return { status: 400, data: { success: false, error: message } } as const;
}

function readInputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function withSessionTargetValidation(
  handler: (context: CapabilityOperationContext) => ReturnType<CapabilityOperationRoute['handle']>,
): CapabilityOperationRoute['handle'] {
  return (context) => {
    if (context.target?.kind !== 'session') {
      return badRequest('Session target is required');
    }
    const input = readInputRecord(context.input);
    const sessionKey = typeof input.sessionKey === 'string' ? input.sessionKey.trim() : '';
    if (sessionKey && sessionKey !== context.target.identity.sessionKey) {
      return badRequest('sessionKey must match target SessionIdentity.sessionKey');
    }
    const inputIdentity = input.sessionIdentity as SessionIdentity | undefined;
    if (inputIdentity && !sessionIdentitiesEqual(inputIdentity, context.target.identity)) {
      return badRequest('SessionIdentity must match capability target identity');
    }
    return handler({
      ...context,
      input: {
        ...input,
        sessionKey: context.target.identity.sessionKey,
        sessionIdentity: context.target.identity,
      },
    });
  };
}

function withApprovalTargetValidation(
  handler: (context: CapabilityOperationContext) => ReturnType<CapabilityOperationRoute['handle']>,
): CapabilityOperationRoute['handle'] {
  return (context) => {
    if (context.target?.kind !== 'approval') {
      return badRequest('Approval target is required');
    }
    const input = readInputRecord(context.input);
    const inputId = typeof input.id === 'string' ? input.id.trim() : '';
    if (inputId && inputId !== context.target.approvalId) {
      return badRequest('approval id must match capability target approvalId');
    }
    const sessionKey = typeof input.sessionKey === 'string' ? input.sessionKey.trim() : '';
    if (sessionKey && sessionKey !== context.target.identity.sessionKey) {
      return badRequest('sessionKey must match target SessionIdentity.sessionKey');
    }
    const inputIdentity = input.sessionIdentity as SessionIdentity | undefined;
    if (inputIdentity && !sessionIdentitiesEqual(inputIdentity, context.target.identity)) {
      return badRequest('SessionIdentity must match capability target identity');
    }
    return handler({
      ...context,
      input: {
        ...input,
        id: context.target.approvalId,
        sessionKey: context.target.identity.sessionKey,
        sessionIdentity: context.target.identity,
      },
    });
  };
}

export function createSessionApprovalCapabilityOperationRoutes(deps: {
  commandService: SessionCommandService;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SESSION_APPROVAL_CAPABILITY_ID,
      operationId: 'approvals.list',
      handle: withSessionTargetValidation((context) => deps.commandService.listPendingApprovals(context.input)),
    },
    {
      capabilityId: SESSION_APPROVAL_CAPABILITY_ID,
      operationId: 'approvals.resolve',
      handle: withApprovalTargetValidation((context) => deps.commandService.resolveApproval(context.input)),
    },
  ];
}
