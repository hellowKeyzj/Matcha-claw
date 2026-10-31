import type { AgentsTransport } from '../runtime-host-delivery/products/agents';
import type { CallLogTransport } from '../runtime-host-delivery/transport/call-log';

type PackageInstallResult = Readonly<{
  outcome: 'accepted' | 'rejected' | 'unknown' | 'notFound';
  skillKey?: string;
  agentId?: string;
  reason?: string;
  error?: string;
  compensation?: Record<string, unknown>;
}>;

export type PackageInstallConfirmation = Readonly<{
  status: number;
  body: { install: PackageInstallResult };
}>;

export async function confirmPackageInstall(
  callId: string,
  dependencies: Readonly<{
    readCall: CallLogTransport['get'];
    readAgentResult: AgentsTransport['result'];
    acknowledge(callId: string, confirmed: boolean): void;
  }>,
): Promise<PackageInstallConfirmation> {
  const result = await dependencies.readCall({ callId });
  if (result.status !== 200 || !('module' in result.body)) {
    return { status: result.status, body: { install: { outcome: 'unknown' } } };
  }
  const call = result.body;
  if (call.callId === callId && call.module === 'subagents' && call.command === 'subagents.package.install'
    && call.detail.endpoint === 'openclaw:local' && ['succeeded', 'failed', 'rejected', 'unknown'].includes(call.status)) {
    const completed = await dependencies.readAgentResult({
      callId, operationId: 'subagents.package.install', endpoint: {
        kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local',
      },
    });
    if (completed.status !== 200 || !isRecord(completed.body) || completed.body.callId !== callId
      || completed.body.operationId !== 'subagents.package.install' || !isRecord(completed.body.body)) {
      return { status: completed.status === 200 ? 502 : completed.status, body: { install: { outcome: 'unknown' } } };
    }
    const install = agentInstallResult(completed.body.body);
    if (install.outcome !== 'accepted') install.outcome = call.status === 'rejected' ? 'rejected' : 'unknown';
    const confirmed = completed.body.status === 200 && call.status === 'succeeded'
      && call.detail.outcome === 'packageInstalled' && install.outcome === 'accepted'
      && install.agentId === call.detail.agentId;
    if ((install.outcome === 'accepted' && !confirmed)
      || (install.outcome !== 'accepted' && (call.status === 'succeeded' || completed.body.status === 200))) {
      return { status: 502, body: { install: { outcome: 'unknown' } } };
    }
    dependencies.acknowledge(callId, confirmed);
    return { status: 200, body: { install } };
  }
  if (call.callId !== callId || call.module !== 'skills' || call.command !== 'sealedSkills.install'
    || !['succeeded', 'failed', 'rejected', 'unknown'].includes(call.status)) {
    return { status: 409, body: { install: { outcome: 'unknown' } } };
  }
  const confirmed = call.status === 'succeeded' && call.detail.access === 'write'
    && call.detail.outcome === 'accepted' && typeof call.detail.skillKey === 'string';
  const install: PackageInstallResult = confirmed
    ? { outcome: 'accepted', skillKey: call.detail.skillKey }
    : { outcome: call.status === 'failed' && call.detail.outcome === 'notFound' ? 'notFound'
      : (call.status === 'failed' || call.status === 'rejected') && call.detail.outcome === 'rejected' ? 'rejected' : 'unknown' };
  dependencies.acknowledge(callId, confirmed);
  return { status: 200, body: { install } };
}

function agentInstallResult(value: unknown): { outcome: 'accepted' | 'rejected' | 'unknown'; agentId?: string; reason?: string; error?: string; compensation?: Record<string, unknown> } {
  if (!isRecord(value)) return { outcome: 'unknown' };
  if (value.outcome === 'rejected' || value.success === false) return {
    outcome: 'rejected', ...installFailureDetail(value),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(isRecord(value.compensation) ? { compensation: {
      outcome: value.compensation.outcome,
      failedCount: value.compensation.failedCount,
      purgeFailedCount: value.compensation.purgeFailedCount,
    } } : {}),
  };
  if (value.success !== true || !isRecord(value.package)) return { outcome: 'unknown', ...installFailureDetail(value) };
  const agentId = typeof value.package.agentId === 'string' ? value.package.agentId.trim() : '';
  return agentId ? { outcome: 'accepted', agentId } : { outcome: 'unknown' };
}

function installFailureDetail(value: Record<string, unknown>): { reason?: string; error?: string } {
  return {
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
