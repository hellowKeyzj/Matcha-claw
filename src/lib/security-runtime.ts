import {
  hostApiFetch,
  waitForRuntimeJobResult,
  type RuntimeJobSubmission,
} from '@/lib/host-api';

export async function hostSecurityReadPolicy<TPolicy = unknown>() {
  return await hostApiFetch<TPolicy>('/api/security');
}

export async function hostSecurityWritePolicy<TResult = unknown>(policy: unknown) {
  const response = await hostApiFetch<RuntimeJobSubmission<TResult> & {
    policy?: unknown;
    sync?: RuntimeJobSubmission<TResult>;
  }>('/api/security', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
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
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>('/api/security/quick-audit', { method: 'POST' });
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostSecurityRunEmergencyResponse<TResult = unknown>() {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>('/api/security/emergency-response', { method: 'POST' });
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostSecurityCheckIntegrity<TResult = unknown>() {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>('/api/security/integrity');
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostSecurityRebaselineIntegrity<TResult = unknown>() {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>('/api/security/integrity/rebaseline', { method: 'POST' });
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostSecurityScanSkills<TResult = unknown>(scanPath?: string) {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>('/api/security/skills/scan', {
    method: 'POST',
    body: JSON.stringify(scanPath ? { scanPath } : {}),
  });
  return await waitForRuntimeJobResult<TResult>(submission.job.id, {
    timeoutMs: 120000,
  });
}

export async function hostSecurityCheckAdvisories<TResult = unknown>() {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>('/api/security/advisories');
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostSecurityPreviewRemediation<TResult = unknown>() {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>('/api/security/remediation/preview');
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostSecurityApplyRemediation<TResult = unknown>(actions?: string[]) {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>('/api/security/remediation/apply', {
    method: 'POST',
    body: JSON.stringify(actions && actions.length > 0 ? { actions } : {}),
  });
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostSecurityRollbackRemediation<TResult = unknown>(snapshotId?: string | null) {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>('/api/security/remediation/rollback', {
    method: 'POST',
    body: JSON.stringify(snapshotId ? { snapshotId } : {}),
  });
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostSecurityFetchRuleCatalog<TResult = { success?: boolean; items?: unknown[] }>() {
  return await hostApiFetch<TResult>('/api/security/destructive-rule-catalog');
}
