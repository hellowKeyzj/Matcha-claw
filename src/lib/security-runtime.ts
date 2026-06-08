import {
  hostApiFetch,
  resolveSingleCapabilityScope,
  waitForRuntimeJobResult,
  type RuntimeJobSubmission,
} from '@/lib/host-api';
import type { CapabilityTarget } from '../../runtime-host/shared/runtime-address';

const SECURITY_RUNTIME_CAPABILITY_ID = 'security.runtime';

async function securityRuntimeCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown> = {},
  target: CapabilityTarget,
): Promise<TResult> {
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId,
      scope: await resolveSingleCapabilityScope(SECURITY_RUNTIME_CAPABILITY_ID),
      target,
      input,
    }),
  });
}

async function submitSecurityCapabilityJob<TResult = unknown>(
  operationId: string,
  input: Record<string, unknown> = {},
  target: CapabilityTarget,
  options?: { timeoutMs?: number },
): Promise<TResult> {
  const submission = await securityRuntimeCapabilityExecute<RuntimeJobSubmission<TResult>>(operationId, input, target);
  return await waitForRuntimeJobResult<TResult>(submission.job.id, options);
}

export async function hostSecurityReadPolicy<TPolicy = unknown>() {
  return await hostApiFetch<TPolicy>('/api/security');
}

export async function hostSecurityWritePolicy<TResult = unknown>(policy: unknown) {
  const response = await securityRuntimeCapabilityExecute<RuntimeJobSubmission<TResult> & {
    policy?: unknown;
    sync?: RuntimeJobSubmission<TResult>;
  }>('security.writePolicy', isRecord(policy) ? policy : {}, { kind: 'security-policy' });
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

export async function hostSecurityRunQuickAudit<TResult = unknown>() {
  return await submitSecurityCapabilityJob<TResult>('security.quickAudit', {}, { kind: 'security-policy' });
}

export async function hostSecurityRunEmergencyResponse<TResult = unknown>() {
  return await submitSecurityCapabilityJob<TResult>('security.emergencyResponse', {}, { kind: 'security-policy' });
}

export async function hostSecurityCheckIntegrity<TResult = unknown>() {
  return await submitSecurityCapabilityJob<TResult>('security.checkIntegrity', {}, { kind: 'security-policy' });
}

export async function hostSecurityRebaselineIntegrity<TResult = unknown>() {
  return await submitSecurityCapabilityJob<TResult>('security.rebaselineIntegrity', {}, { kind: 'security-policy' });
}

export async function hostSecurityScanSkills<TResult = unknown>(scanPath?: string) {
  return await submitSecurityCapabilityJob<TResult>(
    'security.scanSkills',
    scanPath ? { scanPath } : {},
    { kind: 'security-policy' },
    { timeoutMs: 120000 },
  );
}

export async function hostSecurityCheckAdvisories<TResult = unknown>(feedUrl?: string | null) {
  return await submitSecurityCapabilityJob<TResult>('security.checkAdvisories', feedUrl ? { feedUrl } : {}, { kind: 'security-policy' });
}

export async function hostSecurityPreviewRemediation<TResult = unknown>() {
  return await submitSecurityCapabilityJob<TResult>('security.previewRemediation', {}, { kind: 'security-remediation' });
}

export async function hostSecurityApplyRemediation<TResult = unknown>(actions?: string[]) {
  return await submitSecurityCapabilityJob<TResult>(
    'security.applyRemediation',
    actions && actions.length > 0 ? { actions } : {},
    { kind: 'security-remediation' },
  );
}

export async function hostSecurityRollbackRemediation<TResult = unknown>(snapshotId?: string | null) {
  return await submitSecurityCapabilityJob<TResult>(
    'security.rollbackRemediation',
    snapshotId ? { snapshotId } : {},
    { kind: 'security-remediation', ...(snapshotId ? { snapshotId } : {}) },
  );
}

export async function hostSecurityFetchRuleCatalog<TResult = { success?: boolean; items?: unknown[] }>() {
  return await hostApiFetch<TResult>('/api/security/destructive-rule-catalog');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
