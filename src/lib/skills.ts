import { hostApiFetch, hostApiFetchDecoded } from './host-api';
import { waitForCall } from './call-log-await';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import type { CallRecord } from '@/types/call-log';
import {
  decodeSkillsOperationResult,
  type SkillBundle,
  type SkillsOperationResult,
} from '@/types/skills-operation-result';

export type SkillsMutationResult = {
  outcome: 'accepted' | 'partial' | 'removed' | 'rejected' | 'unknown' | 'notFound';
  skillKey?: string;
  slug?: string;
  version?: string;
  invalidKeys?: string[];
};

async function skillsTerminal(receipt: unknown, command: string, input: Record<string, unknown>): Promise<CallRecord<'skills'>> {
  const call = await waitForCall(decodeCallReceipt(receipt), 'skills');
  const access = ['skills.bundles.export', 'skills.exportBundles', 'sealedSkills.export', 'sealedSkills.exportCloud'].includes(command) ? 'read' : 'write';
  if (call.command !== command || call.detail.access !== access) throw new Error('Invalid Skills call identity');
  for (const key of ['skillKey', 'slug', 'version', 'enabled', 'uploadId', 'sha256'] as const) {
    if (input[key] !== undefined && call.detail[key] !== input[key]) throw new Error('Invalid Skills call identity');
  }
  return call;
}

async function operationResult(call: CallRecord<'skills'>, input: Record<string, unknown>): Promise<SkillsOperationResult> {
  if (call.detail.resultReady !== true) throw new Error('Skills operation result unavailable');
  const response = await hostApiFetchDecoded('/api/skills/operations/result', decodeSkillsOperationResult, {
    method: 'POST', body: JSON.stringify({ callId: call.callId }),
  });
  const result = response.result;
  if (response.callId !== call.callId || response.command !== call.command || result.outcome !== call.detail.result
    || (result.outcome === 'accepted' ? call.status !== 'succeeded'
      : result.outcome === 'partial' ? call.status !== 'failed'
        : result.outcome === 'rejected' ? !['rejected', 'failed'].includes(call.status)
          : !['unknown', 'failed'].includes(call.status))) throw new Error('Invalid Skills result identity');
  if (result.kind === 'config' && result.skillKey !== input.skillKey) throw new Error('Invalid Skills config identity');
  if (result.kind === 'batchState') {
    if (!Array.isArray(input.skillKeys) || result.enabled !== input.enabled
      || result.requested.length !== input.skillKeys.length
      || result.requested.some((key, index) => key !== (input.skillKeys as unknown[])[index])) throw new Error('Invalid Skills batch identity');
    const completed = [...result.updated, ...result.failed.map((item) => item.skillKey)];
    if (new Set(completed).size !== completed.length || completed.length !== result.requested.length
      || completed.some((key) => !result.requested.includes(key))
      || (result.success && result.updated.length !== result.requested.length)) throw new Error('Invalid Skills batch result');
    for (const [field, count] of [['requestedCount', result.requested.length], ['updatedCount', result.updated.length],
      ['invalidCount', result.invalidKeys.length], ['failedCount', result.failed.length]] as const) {
      if (call.detail[field] !== count) throw new Error('Invalid Skills batch counts');
    }
  }
  if (result.kind === 'uploadCommit' && result.receipt
    && (result.receipt.uploadId !== input.uploadId || (input.sha256 !== undefined && result.receipt.sha256 !== input.sha256))) {
    throw new Error('Invalid Skills upload identity');
  }
  if (result.kind === 'bundleExport' && result.outcome === 'accepted') {
    const keys = result.skillBundles!.map((bundle) => bundle.skillKey);
    if (!Array.isArray(input.skillKeys) || new Set(keys).size !== keys.length
      || keys.some((key) => !(input.skillKeys as unknown[]).includes(key))) throw new Error('Invalid Skills export identity');
  }
  return result;
}

export async function waitForSkillsOperation(receipt: unknown, command: string, input: Record<string, unknown>): Promise<SkillsOperationResult> {
  return operationResult(await skillsTerminal(receipt, command, input), input);
}

export async function waitForSkillsMutation(
  receipt: unknown,
  command: string,
  input: Record<string, unknown> = {},
): Promise<SkillsMutationResult> {
  const call = await skillsTerminal(receipt, command, input);
  const detail = call.detail;
  if (['skills.config', 'skills.updateConfig', 'skills.updateState'].includes(command)) {
    const result = await operationResult(call, input);
    if (result.kind !== 'config') throw new Error('Invalid Skills config result');
    return result;
  }
  let outcome: SkillsMutationResult['outcome'];
  if (call.status === 'unknown') outcome = 'unknown';
  else if (call.status === 'rejected' && detail.outcome === 'rejected') outcome = 'rejected';
  else if (call.status === 'failed' && detail.outcome === 'notFound') outcome = 'notFound';
  else if (call.status === 'failed') outcome = 'unknown';
  else if (call.status === 'succeeded' && detail.outcome === 'removed' && ['skills.uninstall', 'sealedSkills.uninstall'].includes(command)) outcome = 'removed';
  else if (call.status === 'succeeded' && (detail.outcome === 'accepted'
    || (['skills.importBundles', 'skills.bundles.import'].includes(command) && detail.outcome === 'succeeded'))) outcome = 'accepted';
  else throw new Error('Invalid Skills terminal outcome');
  if (outcome === 'accepted' && command === 'sealedSkills.install' && !detail.skillKey) throw new Error('Invalid Skills install result');
  return {
    outcome,
    ...(detail.skillKey === undefined ? {} : { skillKey: detail.skillKey }),
    ...(detail.slug === undefined ? {} : { slug: detail.slug }),
    ...(detail.version === undefined ? {} : { version: detail.version }),
  };
}

export async function hostSkillsMutation(path: string, input: Record<string, unknown>, command: string): Promise<SkillsMutationResult> {
  const receipt = await hostApiFetch<unknown>(path, { method: 'POST', body: JSON.stringify(input) });
  return waitForSkillsMutation(receipt, command, input);
}

export async function hostExportSkillBundles(skillKeys: string[]): Promise<SkillBundle[]> {
  const input = { skillKeys };
  const receipt = await hostApiFetch<unknown>('/api/subagents/skill-bundles/export', { method: 'POST', body: JSON.stringify(input) });
  const result = await waitForSkillsOperation(receipt, 'skills.bundles.export', input);
  if (result.kind !== 'bundleExport' || result.outcome !== 'accepted') throw new Error('Skill bundle export failed');
  return result.skillBundles!;
}
