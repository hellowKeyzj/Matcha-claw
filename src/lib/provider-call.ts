import { waitForCall } from '@/lib/call-log-await';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import { decodeProviderCallDetail, type ProviderCallDetail } from '@/types/call-log/provider';

const MUTATION_KINDS = {
  'providerAccounts.replace': 'replaceAccount',
  'providerAccounts.delete': 'deleteAccount',
  'providerModels.replace': 'replaceModels',
  'providerRouting.replace': 'replaceRouting',
} as const;

export async function waitForProviderMutation(
  value: unknown,
  command: keyof typeof MUTATION_KINDS,
  target?: { accountId: string; accountRevision?: number },
): Promise<ProviderCallDetail> {
  const call = await waitForCall(decodeCallReceipt(value), 'provider');
  const detail = decodeProviderCallDetail(call.detail);
  if (call.command !== command || !detail || detail.kind !== MUTATION_KINDS[command]
    || (target && (detail.accountId !== target.accountId
      || (target.accountRevision !== undefined && detail.accountRevision !== target.accountRevision)))) {
    throw new Error('Provider mutation call identity is invalid');
  }
  return detail;
}

export function isProviderMutationCommitted(detail: ProviderCallDetail, outcome: 'stored' | 'deleted'): boolean {
  return detail.phase === 'terminal' && detail.outcome === outcome
    && detail.commit === 'committed' && detail.persisted === 'confirmed' && detail.native !== null
    && detail.diagnostic?.reason !== 'private-transaction-settle-failed';
}
