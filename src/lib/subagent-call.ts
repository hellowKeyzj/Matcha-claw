import { hostApiFetch } from '@/lib/host-api';
import { waitForCall } from '@/lib/call-log-await';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import { decodeSubagentsCallDetail } from '@/types/call-log/subagents';
import type { RuntimeEndpointRef } from '@/types/desktop/runtime-address';

const COMMANDS = new Set([
  'subagents.create', 'subagents.update', 'subagents.delete',
  'subagents.description.set', 'subagents.model.set', 'subagents.skills.set',
  'subagentSkills.set', 'subagentTools.set', 'subagents.package.install',
  'subagents.package.export', 'subagents.package.exportCloud',
]);

export function isSubagentMutation(command: string): boolean {
  return COMMANDS.has(command);
}

export async function waitForSubagentResult(
  value: unknown,
  operationId: string,
  endpoint: RuntimeEndpointRef,
  agentId?: string,
): Promise<{ callId: string; status: 200 | 409 | 422 | 503; body: Record<string, unknown> }> {
  const receipt = decodeCallReceipt(value);
  const call = await waitForCall(receipt, 'subagents');
  const detail = decodeSubagentsCallDetail(call.detail);
  const packageExport = operationId === 'subagents.package.export' || operationId === 'subagents.package.exportCloud';
  if (!COMMANDS.has(operationId) || endpoint.kind !== 'native-runtime' || !detail
    || call.command !== operationId || detail.endpoint !== `${endpoint.runtimeAdapterId}:${endpoint.runtimeInstanceId}`
    || (packageExport && agentId === undefined)
    || (agentId !== undefined && (!packageExport || detail.agentId !== null) && detail.agentId !== agentId)
    || detail.outcome === null) {
    throw new Error('Invalid Subagent mutation call identity');
  }
  const result = await hostApiFetch<unknown>('/api/subagents/results', {
    method: 'POST', body: JSON.stringify({ callId: receipt.callId, operationId, endpoint, ...(agentId === undefined ? {} : { agentId }) }),
  });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Subagent mutation result');
  const record = result as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || record.callId !== receipt.callId || record.operationId !== operationId
    || ![200, 409, 422, 503].includes(record.status as number)
    || !record.body || typeof record.body !== 'object' || Array.isArray(record.body)) {
    throw new Error('Invalid Subagent mutation result');
  }
  const body = record.body as Record<string, unknown>;
  const outcome = body.resultType ?? (operationId === 'subagents.package.install' ? 'packageInstalled'
    : operationId === 'subagents.package.export' || operationId === 'subagents.package.exportCloud' ? 'packageExported'
      : body.kind ?? 'configurationApplied');
  const expectedOutcome = outcome === 'updated' && operationId === 'subagentSkills.set' ? 'skillConfigurationUpdated'
    : outcome === 'updated' && operationId === 'subagentTools.set' ? 'toolConfigurationUpdated' : outcome;
  if (body.success === true && (detail.outcome !== expectedOutcome
    || (typeof body.resultType === 'string' && body.resultType !== 'updated'
      ? call.status !== 'rejected' : call.status !== 'succeeded'))) {
    throw new Error('Invalid Subagent mutation terminal outcome');
  }
  if (body.success === false) {
    const failureOutcomes = ['rejected', 'outcomeUnknown', 'unsupported', 'unavailable', 'unexpectedOutcome'];
    if (operationId === 'subagents.create' && body.agent) failureOutcomes.splice(0, failureOutcomes.length, 'workspaceInitializationFailed');
    if (operationId === 'subagents.delete' && body.kind === 'deleted') {
      const nativeSucceeded = body.nativeOk === true && body.failedCount === 0 && body.purgeFailedCount === 0;
      failureOutcomes.splice(0, failureOutcomes.length, nativeSucceeded ? 'sealedPurgeFailed' : 'nativeDeleteFailed');
    }
    if (operationId === 'subagents.package.install' && body.compensation) {
      const compensation = body.compensation as { outcome: string };
      failureOutcomes.splice(0, failureOutcomes.length, compensation.outcome === 'deleted' ? 'packageInstallFailedCompensated'
        : compensation.outcome === 'outcomeUnknown' ? 'packageInstallCompensationUnknown' : 'packageInstallCompensationFailed');
    }
    const expectedStatus = ['outcomeUnknown', 'unexpectedOutcome', 'packageInstallCompensationUnknown'].includes(detail.outcome) ? 'unknown'
      : ['rejected', 'unsupported'].includes(detail.outcome) ? 'rejected' : 'failed';
    if (call.status !== expectedStatus || !failureOutcomes.includes(detail.outcome)) throw new Error('Invalid Subagent mutation terminal outcome');
  } else if (body.success !== true || record.status !== 200) throw new Error('Invalid Subagent mutation result');
  const resultAgentId = (body.agent as { id?: string } | undefined)?.id
    ?? (body.package as { agentId?: string } | undefined)?.agentId ?? body.agentId ?? agentId;
  if (packageExport && body.success === true && (body.package as { agentId?: string } | undefined)?.agentId !== agentId) {
    throw new Error('Invalid Subagent mutation result identity');
  }
  if (typeof resultAgentId === 'string' && (!packageExport || detail.agentId !== null) && detail.agentId !== resultAgentId) {
    throw new Error('Invalid Subagent mutation result identity');
  }
  return { callId: receipt.callId, status: record.status as 200 | 409 | 422 | 503, body };
}

export async function waitForSubagentMutation<TResult>(
  receipt: unknown,
  command: string,
  endpoint: RuntimeEndpointRef,
  agentId?: string,
): Promise<TResult> {
  const result = await waitForSubagentResult(receipt, command, endpoint, agentId);
  if (command === 'subagents.skills.set' && result.body.resultType === 'invalidSkillKeys') {
    throw new Error(`Invalid subagent skill keys (unknown: ${(result.body.unknownSkillKeys as string[]).join(', ')}, non-canonical: ${(result.body.nonCanonicalSkillKeys as string[]).join(', ')})`);
  }
  if (result.body.success === false && !(command === 'subagents.create' && result.body.agent)) {
    throw new Error(subagentMutationError(result.body));
  }
  return result.body as TResult;
}

export function subagentMutationError(body: Record<string, unknown>): string {
  if (body.kind === 'deleted') {
    return `Subagent deletion failed (nativeOk: ${body.nativeOk}, failedCount: ${body.failedCount}, purgeFailedCount: ${body.purgeFailedCount}, sealedPurge: ${body.sealedPurge})`;
  }
  if (body.compensation && typeof body.compensation === 'object' && !Array.isArray(body.compensation)) {
    const compensation = body.compensation as Record<string, unknown>;
    return `Subagent package installation failed (agentId: ${body.agentId}, compensation: ${compensation.outcome}, failedCount: ${compensation.failedCount}, purgeFailedCount: ${compensation.purgeFailedCount})`;
  }
  return typeof body.error === 'string' ? body.error : 'Subagent mutation outcome is unknown';
}
