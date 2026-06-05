import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';
import type { SessionCommandService } from '../../sessions/session-command-service';

export const SESSION_APPROVAL_CAPABILITY_ID = 'session.approval';

export const sessionApprovalCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'approvals.list', title: 'List approvals' },
  { id: 'approvals.resolve', title: 'Resolve approval' },
] as const;

export function createSessionApprovalCapabilityOperationRoutes(deps: {
  commandService: SessionCommandService;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SESSION_APPROVAL_CAPABILITY_ID,
      operationId: 'approvals.list',
      handle: (context) => deps.commandService.listPendingApprovals(context.input),
    },
    {
      capabilityId: SESSION_APPROVAL_CAPABILITY_ID,
      operationId: 'approvals.resolve',
      handle: (context) => deps.commandService.resolveApproval(context.input),
    },
  ];
}
