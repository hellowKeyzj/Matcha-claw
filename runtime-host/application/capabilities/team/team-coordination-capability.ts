import type { TeamRuntimeService } from '../../team-runtime/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const TEAM_COORDINATION_CAPABILITY_ID = 'team.coordination';

export const teamCoordinationCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'team.init', title: 'Initialize team run' },
  { id: 'team.snapshot', title: 'Read team snapshot' },
  { id: 'team.planUpsert', title: 'Upsert team plan' },
  { id: 'team.claimNext', title: 'Claim next team task' },
  { id: 'team.heartbeat', title: 'Refresh team task claim' },
  { id: 'team.taskUpdate', title: 'Update team task status' },
  { id: 'team.mailboxPost', title: 'Post team mailbox message' },
  { id: 'team.mailboxPull', title: 'Pull team mailbox messages' },
  { id: 'team.releaseClaim', title: 'Release team task claim' },
  { id: 'team.reset', title: 'Reset team run' },
  { id: 'team.listTasks', title: 'List team tasks' },
] as const;

export function createTeamCoordinationCapabilityOperationRoutes(deps: {
  teamRuntimeService: TeamRuntimeService;
}): readonly CapabilityOperationRoute[] {
  const value = async (result: Promise<unknown>) => ({ status: 200, data: await result });
  return [
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.init', handle: (context) => value(deps.teamRuntimeService.init(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.snapshot', handle: (context) => value(deps.teamRuntimeService.snapshot(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.planUpsert', handle: (context) => value(deps.teamRuntimeService.planUpsert(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.claimNext', handle: (context) => value(deps.teamRuntimeService.claimNext(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.heartbeat', handle: (context) => value(deps.teamRuntimeService.heartbeat(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.taskUpdate', handle: (context) => value(deps.teamRuntimeService.taskUpdate(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.mailboxPost', handle: (context) => value(deps.teamRuntimeService.mailboxPost(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.mailboxPull', handle: (context) => value(deps.teamRuntimeService.mailboxPull(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.releaseClaim', handle: (context) => value(deps.teamRuntimeService.releaseClaim(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.reset', handle: (context) => value(deps.teamRuntimeService.reset(context.input)) },
    { capabilityId: TEAM_COORDINATION_CAPABILITY_ID, operationId: 'team.listTasks', handle: (context) => value(deps.teamRuntimeService.listTasks(context.input)) },
  ];
}
