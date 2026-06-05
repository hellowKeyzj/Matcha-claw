import type { SubagentRuntimeService } from '../../subagents/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const SUBAGENT_MANAGEMENT_CAPABILITY_ID = 'subagent.management';

export const subagentManagementCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'subagents.config.set', title: 'Set subagent configuration' },
  { id: 'subagents.create', title: 'Create subagent' },
  { id: 'subagents.update', title: 'Update subagent' },
  { id: 'subagents.delete', title: 'Delete subagent' },
  { id: 'subagents.files.set', title: 'Set subagent file' },
] as const;

export function createSubagentManagementCapabilityOperationRoutes(deps: {
  subagentService: Pick<SubagentRuntimeService,
    | 'setConfig'
    | 'createAgent'
    | 'updateAgent'
    | 'deleteAgent'
    | 'setAgentFile'
  >;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.config.set',
      handle: (context) => deps.subagentService.setConfig(context.domainInput),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.create',
      handle: (context) => deps.subagentService.createAgent(context.domainInput),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.update',
      handle: (context) => deps.subagentService.updateAgent(context.domainInput),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.delete',
      handle: (context) => deps.subagentService.deleteAgent(context.domainInput),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.files.set',
      handle: (context) => deps.subagentService.setAgentFile(context.domainInput),
    },
  ];
}

