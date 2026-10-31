import { traceDebug } from '../../utils/trace-logger';
import { summarizeIdentifier } from '../runtime-host-delivery/transport/sessions/trace';
import type { ProviderCallDetail } from '../../../src/types/call-log/provider';
import type { ProviderAccountIntent as AccountIntent } from './account-intent';

export function providerPrivateAuthTrace(phase: string, payload: () => Record<string, unknown> = () => ({})): void {
  traceDebug(() => JSON.stringify({
    prefix: '[startup-trace]',
    source: 'provider-private-auth',
    phase,
    at: Date.now(),
    ...payload(),
  }));
}

export function idShape(value: string | null | undefined): { present: boolean; length: number } {
  return value ? { present: true, length: value.length } : { present: false, length: 0 };
}

export function accountTrace(account: AccountIntent): Record<string, unknown> {
  return {
    accountId: idShape(account.id),
    provider: account.provider,
    authMode: account.authMode,
    kind: account.kind,
    enabled: account.enabled,
    revision: account.revision,
    endpoint: idShape(account.endpoint),
    protocol: account.protocol,
    mediaProtocol: account.mediaProtocol,
  };
}

export function detailTrace(detail: ProviderCallDetail | undefined): Record<string, unknown> {
  if (!detail) return {};
  return {
    persisted: detail.persisted,
    commit: detail.commit,
    diagnostic: detail.diagnostic,
    native: detail.native && {
      changed: detail.native.changed,
      applied: detail.native.applied,
      observed: detail.native.observed,
      reports: detail.native.reports.map((report) => ({
        endpoint: report.endpoint,
        changed: report.changed,
        applied: report.applied,
        observed: report.observed,
        diagnostic: report.diagnostic,
        accounts: report.accounts.map((account) => ({
          accountId: summarizeIdentifier(account.accountId),
          accountRevision: account.accountRevision,
          execution: account.execution,
          diagnostic: account.diagnostic,
        })),
      })),
    },
  };
}
