import { hostApiFetch } from '@/lib/host-api';

export async function hostSecurityReadPolicy<TPolicy = unknown>() {
  return await hostApiFetch<TPolicy>('/api/security');
}

export async function hostSecurityWritePolicy<TResult = unknown>(policy: unknown) {
  return await hostApiFetch<TResult>('/api/security', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
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
  return await hostApiFetch<TResult>('/api/security/quick-audit', { method: 'POST' });
}

export async function hostSecurityRunEmergencyResponse<TResult = unknown>() {
  return await hostApiFetch<TResult>('/api/security/emergency-response', { method: 'POST' });
}

export async function hostSecurityCheckIntegrity<TResult = unknown>() {
  return await hostApiFetch<TResult>('/api/security/integrity');
}

export async function hostSecurityRebaselineIntegrity<TResult = unknown>() {
  return await hostApiFetch<TResult>('/api/security/integrity/rebaseline', { method: 'POST' });
}

export async function hostSecurityScanSkills<TResult = unknown>(scanPath?: string) {
  return await hostApiFetch<TResult>('/api/security/skills/scan', {
    method: 'POST',
    body: JSON.stringify(scanPath ? { scanPath } : {}),
  });
}

export async function hostSecurityCheckAdvisories<TResult = unknown>() {
  return await hostApiFetch<TResult>('/api/security/advisories');
}

export async function hostSecurityPreviewRemediation<TResult = unknown>() {
  return await hostApiFetch<TResult>('/api/security/remediation/preview');
}

export async function hostSecurityApplyRemediation<TResult = unknown>(actions?: string[]) {
  return await hostApiFetch<TResult>('/api/security/remediation/apply', {
    method: 'POST',
    body: JSON.stringify(actions && actions.length > 0 ? { actions } : {}),
  });
}

export async function hostSecurityRollbackRemediation<TResult = unknown>(snapshotId?: string | null) {
  return await hostApiFetch<TResult>('/api/security/remediation/rollback', {
    method: 'POST',
    body: JSON.stringify(snapshotId ? { snapshotId } : {}),
  });
}

export async function hostSecurityFetchRuleCatalog<TResult = { success?: boolean; items?: unknown[] }>() {
  return await hostApiFetch<TResult>('/api/security/destructive-rule-catalog');
}
