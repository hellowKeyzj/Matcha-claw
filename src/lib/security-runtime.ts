import { hostApiFetch } from '@/lib/host-api';
import { waitForCall } from '@/lib/call-log-await';
import type { CallReceipt } from '@/types/call-log';
import { decodeSecurityCallDetail } from '@/types/call-log/security';

type SecurityOperationScopeKind = 'security-policy' | 'security-remediation';
type SecurityOperationTarget = Readonly<{
  kind: SecurityOperationScopeKind;
  snapshotId?: string;
}>;
type SecurityOperationId =
  | 'security.quickAudit'
  | 'security.checkIntegrity'
  | 'security.rebaselineIntegrity'
  | 'security.scanSkills'
  | 'security.checkAdvisories'
  | 'security.previewRemediation'
  | 'security.applyRemediation'
  | 'security.rollbackRemediation';

async function hostSecurityOperation<TResult>(
  operationId: SecurityOperationId,
  scopeKind: SecurityOperationScopeKind,
  input: Record<string, unknown>,
  target: SecurityOperationTarget = { kind: scopeKind },
): Promise<TResult> {
  const receipt = await hostApiFetch<CallReceipt>('/api/security/operation', {
    method: 'POST',
    body: JSON.stringify({
      id: 'security.operation',
      operationId,
      scope: { kind: scopeKind },
      target,
      input,
    }),
  });
  const call = await waitForCall(receipt, 'security');
  const detail = decodeSecurityCallDetail(call.detail);
  if (!detail || detail.kind !== 'operation' || `security.${detail.operation}` !== operationId) throw new Error('Invalid security operation receipt');
  return await hostApiFetch<TResult>('/api/security/operation/receipt', {
    method: 'POST', body: JSON.stringify({ correlation: detail.correlation, operationId }),
  });
}

export type SecurityPolicyReceipt = Readonly<{
  desired: Readonly<{
    revision: number;
    outcome: 'confirmed' | 'outcome_unknown';
  }>;
}>;

export async function hostSecurityReadPolicy<TPolicy = unknown>(options?: { traceId?: string | null }) {
  return await hostApiFetch<TPolicy>('/api/security', { traceId: options?.traceId });
}

export async function hostSecurityWritePolicy(policy: unknown): Promise<SecurityPolicyReceipt> {
  const receipt = await hostApiFetch<CallReceipt>('/api/security/policy', {
    method: 'POST',
    body: JSON.stringify({
      id: 'security.policy',
      operationId: 'security.replace',
      scope: { kind: 'security-policy' },
      target: { kind: 'security-policy' },
      input: { policy: isRecord(policy) ? policy : {} },
    }),
  });
  const call = await waitForCall(receipt, 'security');
  const detail = decodeSecurityCallDetail(call.detail);
  if (!detail || detail.kind !== 'policyReplace') throw new Error('Invalid security policy receipt');
  if (detail.effect === 'rejected') throw new Error('Security policy effect was rejected');
  if (detail.revision === null) throw new Error('Security policy outcome is unknown');
  return { desired: { revision: detail.revision, outcome: detail.effect === 'confirmed' ? 'confirmed' : 'outcome_unknown' } };
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

export type SecurityEmergencyResponse = Readonly<{
  outcome: 'applied' | 'target_rejected' | 'outcome_unknown';
}>;

export const SECURITY_EMERGENCY_TARGET_REJECTED_MESSAGE = 'Security emergency target was rejected; verify the active security runtime.';
export const SECURITY_EMERGENCY_OUTCOME_UNKNOWN_MESSAGE = 'Security emergency outcome is unknown; verify manually.';

export type SecurityEmergencyOutcome =
  | Readonly<{ outcome: 'applied' }>
  | Readonly<{ outcome: 'target_rejected' }>
  | Readonly<{ outcome: 'outcome_unknown'; message: typeof SECURITY_EMERGENCY_OUTCOME_UNKNOWN_MESSAGE }>;

export function resolveSecurityEmergencyOutcome(response: SecurityEmergencyResponse): SecurityEmergencyOutcome {
  switch (response.outcome) {
    case 'applied':
      return { outcome: 'applied' };
    case 'target_rejected':
      return { outcome: 'target_rejected' };
    case 'outcome_unknown':
      return { outcome: 'outcome_unknown', message: SECURITY_EMERGENCY_OUTCOME_UNKNOWN_MESSAGE };
  }
}

export async function hostSecurityRunEmergencyResponse(): Promise<SecurityEmergencyResponse> {
  const receipt = await hostApiFetch<CallReceipt>('/api/security/emergency', {
    method: 'POST',
    body: '{}',
  });
  const call = await waitForCall(receipt, 'security');
  const detail = decodeSecurityCallDetail(call.detail);
  if (!detail || detail.kind !== 'emergency') throw new Error('Invalid security emergency receipt');
  if (detail.outcome === 'unavailable') throw new Error('Security emergency is unavailable');
  return { outcome: detail.outcome ?? 'outcome_unknown' };
}

export async function hostSecurityRunQuickAudit<TResult = unknown>(): Promise<TResult> {
  return await hostSecurityOperation<TResult>('security.quickAudit', 'security-policy', {});
}

export async function hostSecurityCheckIntegrity<TResult = unknown>(): Promise<TResult> {
  return await hostSecurityOperation<TResult>('security.checkIntegrity', 'security-policy', {});
}

export async function hostSecurityRebaselineIntegrity<TResult = unknown>(): Promise<TResult> {
  return await hostSecurityOperation<TResult>('security.rebaselineIntegrity', 'security-policy', {});
}

export async function hostSecurityScanSkills<TResult = unknown>(scanPath?: string): Promise<TResult> {
  return await hostSecurityOperation<TResult>('security.scanSkills', 'security-policy', scanPath ? { scanPath } : {});
}

export async function hostSecurityCheckAdvisories<TResult = unknown>(feedUrl?: string | null): Promise<TResult> {
  return await hostSecurityOperation<TResult>(
    'security.checkAdvisories',
    'security-policy',
    feedUrl === undefined ? {} : { feedUrl },
  );
}

export async function hostSecurityPreviewRemediation<TResult = unknown>(): Promise<TResult> {
  return await hostSecurityOperation<TResult>('security.previewRemediation', 'security-remediation', {});
}

export async function hostSecurityApplyRemediation<TResult = unknown>(actions?: string[]): Promise<TResult> {
  return await hostSecurityOperation<TResult>(
    'security.applyRemediation',
    'security-remediation',
    actions === undefined ? {} : { actions },
  );
}

export async function hostSecurityRollbackRemediation<TResult = unknown>(snapshotId?: string | null): Promise<TResult> {
  const input = snapshotId === undefined ? {} : { snapshotId };
  const target = typeof snapshotId === 'string' && snapshotId.length > 0
    ? { kind: 'security-remediation' as const, snapshotId }
    : { kind: 'security-remediation' as const };
  return await hostSecurityOperation<TResult>(
    'security.rollbackRemediation',
    'security-remediation',
    input,
    target,
  );
}

export async function hostSecurityFetchRuleCatalog<TResult = { success?: boolean; items?: unknown[] }>() {
  return await hostApiFetch<TResult>('/api/security/destructive-rule-catalog');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
