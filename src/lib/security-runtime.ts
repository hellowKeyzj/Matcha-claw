import {
  hostApiFetch,
  hostCapabilityExecute,
  waitForRuntimeJobResult,
  type RuntimeJobSubmission,
} from '@/lib/host-api';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

const SECURITY_RUNTIME_CAPABILITY_ID = 'security.runtime';

async function securityRuntimeCapabilityExecute<TResult>(operationId: string, runtimeAddress: RuntimeAddress, input: Record<string, unknown> = {}): Promise<TResult> {
  return await hostCapabilityExecute<TResult>({
    id: SECURITY_RUNTIME_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  });
}

async function submitSecurityCapabilityJob<TResult = unknown>(operationId: string, runtimeAddress: RuntimeAddress, input: Record<string, unknown> = {}, options?: { timeoutMs?: number }): Promise<TResult> {
  const submission = await securityRuntimeCapabilityExecute<RuntimeJobSubmission<TResult>>(operationId, runtimeAddress, input);
  return await waitForRuntimeJobResult<TResult>(submission.job.id, options);
}

export async function hostSecurityReadPolicy<TPolicy = unknown>() {
  return await hostApiFetch<TPolicy>('/api/security');
}

export async function hostSecurityWritePolicy<TResult = unknown>(policy: unknown, runtimeAddress: RuntimeAddress) {
  const response = await securityRuntimeCapabilityExecute<RuntimeJobSubmission<TResult> & {
    policy?: unknown;
    sync?: RuntimeJobSubmission<TResult>;
  }>('security.writePolicy', runtimeAddress, isRecord(policy) ? policy : {});
  const jobId = response.sync?.job?.id ?? response.job?.id;
  if (jobId) {
    await waitForRuntimeJobResult<TResult>(jobId);
  }
  return response as TResult;
}

export async function hostSecurityReadAudit<TResult = unknown>(params?: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  return await hostApiFetch<TResult>(`/api/security/audit${suffix}`);
}

export async function hostSecurityRunQuickAudit<TResult = unknown>(runtimeAddress: RuntimeAddress) {
  return await submitSecurityCapabilityJob<TResult>('security.quickAudit', runtimeAddress);
}

export async function hostSecurityRunEmergencyResponse<TResult = unknown>(runtimeAddress: RuntimeAddress) {
  return await submitSecurityCapabilityJob<TResult>('security.emergencyResponse', runtimeAddress);
}

export async function hostSecurityCheckIntegrity<TResult = unknown>(runtimeAddress: RuntimeAddress) {
  return await submitSecurityCapabilityJob<TResult>('security.checkIntegrity', runtimeAddress);
}

export async function hostSecurityRebaselineIntegrity<TResult = unknown>(runtimeAddress: RuntimeAddress) {
  return await submitSecurityCapabilityJob<TResult>('security.rebaselineIntegrity', runtimeAddress);
}

export async function hostSecurityScanSkills<TResult = unknown>(runtimeAddress: RuntimeAddress, scanPath?: string) {
  return await submitSecurityCapabilityJob<TResult>(
    'security.scanSkills',
    runtimeAddress,
    scanPath ? { scanPath } : {},
    { timeoutMs: 120000 },
  );
}

export async function hostSecurityCheckAdvisories<TResult = unknown>(runtimeAddress: RuntimeAddress, feedUrl?: string | null) {
  return await submitSecurityCapabilityJob<TResult>('security.checkAdvisories', runtimeAddress, feedUrl ? { feedUrl } : {});
}

export async function hostSecurityPreviewRemediation<TResult = unknown>(runtimeAddress: RuntimeAddress) {
  return await submitSecurityCapabilityJob<TResult>('security.previewRemediation', runtimeAddress);
}

export async function hostSecurityApplyRemediation<TResult = unknown>(runtimeAddress: RuntimeAddress, actions?: string[]) {
  return await submitSecurityCapabilityJob<TResult>('security.applyRemediation', runtimeAddress, actions && actions.length > 0 ? { actions } : {});
}

export async function hostSecurityRollbackRemediation<TResult = unknown>(runtimeAddress: RuntimeAddress, snapshotId?: string | null) {
  return await submitSecurityCapabilityJob<TResult>('security.rollbackRemediation', runtimeAddress, snapshotId ? { snapshotId } : {});
}

export async function hostSecurityFetchRuleCatalog<TResult = { success?: boolean; items?: unknown[] }>() {
  return await hostApiFetch<TResult>('/api/security/destructive-rule-catalog');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
