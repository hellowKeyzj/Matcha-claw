import { hostApiFetch, hostApiFetchDecoded } from './host-api';
import { waitForCall } from './call-log-await';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import type { CallRecord } from '@/types/call-log';
import type { WaitForCallOptions } from '@/types/call-log/wait';
import { useRuntimeEndpointsStore, selectManagementEndpoint, selectManagementAgentScope } from '@/stores/runtime-endpoints';
import { runtimeInstanceScope, type AgentScope, type RuntimeInstanceScope } from '@/types/desktop/runtime-address';

export function selectedSkillsScope(): AgentScope | RuntimeInstanceScope | null {
  const state = useRuntimeEndpointsStore.getState();
  const endpoint = selectManagementEndpoint(state);
  if (endpoint?.kind !== 'native-runtime') return null;
  if (endpoint.runtimeAdapterId === 'openclaw') return runtimeInstanceScope(endpoint);
  return endpoint.runtimeAdapterId === 'matcha-agent' ? selectManagementAgentScope(state) : null;
}

export function requireSkillsScope(): AgentScope | RuntimeInstanceScope {
  const scope = selectedSkillsScope();
  if (!scope) throw new Error('Select a runtime and Agent before managing skills');
  return scope;
}
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
  reason?: string;
};

async function skillsTerminal(receipt: unknown, command: string, input: Record<string, unknown>, options?: WaitForCallOptions<'skills'>): Promise<CallRecord<'skills'>> {
  const call = await waitForCall(decodeCallReceipt(receipt), 'skills', options);
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
    method: 'POST', body: JSON.stringify({ callId: call.callId, ...(input.scope ? { scope: input.scope } : {}) }),
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
  options?: WaitForCallOptions<'skills'>,
): Promise<SkillsMutationResult> {
  const call = await skillsTerminal(receipt, command, input, options);
  const detail = call.detail;
  if (['skills.config', 'skills.updateConfig', 'skills.updateState'].includes(command)) {
    const result = await operationResult(call, input);
    if (result.kind !== 'config') throw new Error('Invalid Skills config result');
    return result;
  }
  let outcome: SkillsMutationResult['outcome'];
  if (call.status === 'unknown') outcome = 'unknown';
  else if ((call.status === 'rejected' || call.status === 'failed') && detail.outcome === 'rejected') outcome = 'rejected';
  else if (call.status === 'failed' && detail.outcome === 'notFound') outcome = 'notFound';
  else if (call.status === 'failed' && detail.outcome === 'partial' && detail.reason === 'cleanup-failed'
    && (command === 'sealedSkills.export' || (command === 'sealedSkills.exportCloud'
      && detail.resultReady === true && detail.result === 'partial'))) outcome = 'partial';
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
    ...(detail.reason === undefined ? {} : { reason: detail.reason }),
  };
}

export async function hostSkillsMutation(path: string, input: Record<string, unknown>, command: string, options?: WaitForCallOptions<'skills'>): Promise<SkillsMutationResult> {
  const receipt = await hostApiFetch<unknown>(path, { method: 'POST', body: JSON.stringify(input) });
  return waitForSkillsMutation(receipt, command, input, options);
}

export async function hostImportSkillArchive(file: File, slug: string, scope: AgentScope): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.zip') || file.size === 0 || file.size > 32 * 1024 * 1024) {
    throw new Error('Select a nonempty ZIP archive no larger than 32 MiB');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const progress = await hostApiFetch<{ uploadId: string; receivedBytes: number }>('/api/skills/upload/begin', {
    method: 'POST', body: JSON.stringify({ kind: 'skill-archive', slug, sizeBytes: bytes.length, sha256, scope }),
  });
  if (!progress.uploadId || progress.receivedBytes !== 0) throw new Error('Invalid skill archive upload receipt');
  // Stay within the existing Host 64 KiB request budget after base64 encoding.
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    const chunk = bytes.subarray(offset, offset + 32 * 1024);
    const dataBase64 = btoa(String.fromCharCode(...chunk));
    const received = await hostApiFetch<{ uploadId: string; receivedBytes: number }>('/api/skills/upload/chunk', {
      method: 'POST', body: JSON.stringify({ uploadId: progress.uploadId, offset, dataBase64, scope }),
    });
    if (received.uploadId !== progress.uploadId || received.receivedBytes !== offset + chunk.length) {
      throw new Error('Invalid skill archive chunk receipt');
    }
  }
  const input = { uploadId: progress.uploadId, sha256, scope };
  const receipt = await hostApiFetch<unknown>('/api/skills/upload/commit', { method: 'POST', body: JSON.stringify(input) });
  const result = await waitForSkillsOperation(receipt, 'skills.upload.commit', input);
  if (result.kind !== 'uploadCommit' || result.outcome !== 'accepted' || result.receipt?.receivedBytes !== bytes.length) {
    throw new Error('Skill archive installation was not confirmed; refresh the selected Agent before retrying');
  }
}

export async function hostExportSkillBundles(skillKeys: string[]): Promise<SkillBundle[]> {
  const input = { skillKeys };
  const receipt = await hostApiFetch<unknown>('/api/subagents/skill-bundles/export', { method: 'POST', body: JSON.stringify(input) });
  const result = await waitForSkillsOperation(receipt, 'skills.bundles.export', input);
  if (result.kind !== 'bundleExport' || result.outcome !== 'accepted') throw new Error('Skill bundle export failed');
  return result.skillBundles!;
}
