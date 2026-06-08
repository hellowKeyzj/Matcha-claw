import { badRequest, type ApplicationResponse } from '../../common/application-response';
import type { SubagentRuntimeService } from '../../subagents/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationContext, CapabilityOperationRoute } from '../contracts/capability-router';

export const SUBAGENT_MANAGEMENT_CAPABILITY_ID = 'subagent.management';

export const subagentManagementCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'subagents.list', title: 'List subagents', targetKind: 'agent' },
  { id: 'subagents.config.get', title: 'Get subagent configuration', targetKind: 'agent' },
  { id: 'subagents.config.set', title: 'Set subagent configuration', targetKind: 'agent' },
  { id: 'subagents.create', title: 'Create subagent', targetKind: 'subagent' },
  { id: 'subagents.update', title: 'Update subagent', targetKind: 'subagent' },
  { id: 'subagents.delete', title: 'Delete subagent', targetKind: 'subagent' },
  { id: 'subagents.files.get', title: 'Get subagent file', targetKind: 'subagent' },
  { id: 'subagents.files.set', title: 'Set subagent file', targetKind: 'subagent' },
  { id: 'subagents.files.list', title: 'List subagent files', targetKind: 'subagent' },
] as const;

type SubagentOperation = (input: Record<string, unknown>) => Promise<ApplicationResponse>;

function readInputString(input: Record<string, unknown>, key: 'agentId' | 'subagentId'): string {
  return typeof input[key] === 'string' ? input[key].trim() : '';
}

function handleAgentTarget(context: CapabilityOperationContext, operation: SubagentOperation): Promise<ApplicationResponse> | ApplicationResponse {
  if (context.target?.kind !== 'agent') {
    return badRequest('agent target is required');
  }
  const requestedAgentId = readInputString(context.domainInput, 'agentId');
  if (requestedAgentId && requestedAgentId !== context.target.agentId) {
    return badRequest('agentId must match agent target');
  }
  const requestedSubagentId = readInputString(context.domainInput, 'subagentId');
  if (requestedSubagentId && requestedSubagentId !== context.target.agentId) {
    return badRequest('subagentId must match agent target');
  }
  return operation({
    ...context.domainInput,
    agentId: context.target.agentId,
  });
}

function handleSubagentTarget(
  context: CapabilityOperationContext,
  operation: SubagentOperation,
  options?: { requireSubagentId?: boolean },
): Promise<ApplicationResponse> | ApplicationResponse {
  if (context.target?.kind !== 'subagent') {
    return badRequest('subagent target is required');
  }
  const targetSubagentId = typeof context.target.subagentId === 'string' ? context.target.subagentId.trim() : '';
  if (options?.requireSubagentId === true && !targetSubagentId) {
    return badRequest('subagent target is required');
  }
  const requestedAgentId = readInputString(context.domainInput, 'agentId');
  if (requestedAgentId && requestedAgentId !== targetSubagentId) {
    return badRequest('agentId must match subagent target');
  }
  const requestedSubagentId = readInputString(context.domainInput, 'subagentId');
  if (requestedSubagentId && requestedSubagentId !== targetSubagentId) {
    return badRequest('subagentId must match subagent target');
  }
  return operation({
    ...context.domainInput,
    ...(targetSubagentId ? { agentId: targetSubagentId, subagentId: targetSubagentId } : {}),
  });
}

export function createSubagentManagementCapabilityOperationRoutes(deps: {
  subagentService: Pick<SubagentRuntimeService,
    | 'listAgents'
    | 'getConfig'
    | 'setConfig'
    | 'createAgent'
    | 'updateAgent'
    | 'deleteAgent'
    | 'getAgentFile'
    | 'setAgentFile'
    | 'listAgentFiles'
  >;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.list',
      handle: (context) => handleAgentTarget(context, () => deps.subagentService.listAgents()),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.config.get',
      handle: (context) => handleAgentTarget(context, () => deps.subagentService.getConfig()),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.config.set',
      handle: (context) => handleAgentTarget(context, (input) => deps.subagentService.setConfig(input)),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.create',
      handle: (context) => handleSubagentTarget(context, (input) => deps.subagentService.createAgent(input)),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.update',
      handle: (context) => handleSubagentTarget(context, (input) => deps.subagentService.updateAgent(input), { requireSubagentId: true }),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.delete',
      handle: (context) => handleSubagentTarget(context, (input) => deps.subagentService.deleteAgent(input), { requireSubagentId: true }),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.files.get',
      handle: (context) => handleSubagentTarget(context, (input) => deps.subagentService.getAgentFile(input), { requireSubagentId: true }),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.files.set',
      handle: (context) => handleSubagentTarget(context, (input) => deps.subagentService.setAgentFile(input), { requireSubagentId: true }),
    },
    {
      capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      operationId: 'subagents.files.list',
      handle: (context) => handleSubagentTarget(context, (input) => deps.subagentService.listAgentFiles(input), { requireSubagentId: true }),
    },
  ];
}

