import type { ProviderAccountsTransport } from '../runtime-host-delivery/transport/providers/accounts';
import type { CallReceipt, CallRecord } from '../../../src/types/call-log';
import type { ProviderCallDetail } from '../../../src/types/call-log/provider';
import { decodeCallReceipt } from '../../../src/types/call-log/receipt';
import { probeAnthropicCliAuth } from './anthropic-cli-probe';
import { parseAccount, isId, isRevision, isSecret, type ProviderAccountIntent } from './account-intent';
import { beginPrivateAccountTransaction, settlePrivateAccountTransaction, type PrivateAccountTransaction } from './account-transactions';
import { encryptSecret, settleCredential, type PrivateCredential } from './credentials';
import { detailTrace, providerPrivateAuthTrace } from './trace';

type AccountIntent = ProviderAccountIntent;
export type AwaitProviderCall = (receipt: CallReceipt, command: 'providerAccounts.replace' | 'providerAccounts.delete') => Promise<CallRecord<'provider'>>;
export type ProviderPrivateAccountDependencies = Readonly<{ transport: ProviderAccountsTransport; awaitProviderCall: AwaitProviderCall; assertCurrent?: () => void }>;

export type PublicMutationOutcome = 'stored' | 'rejected' | 'unknown' | 'unavailable';
type PublicDeleteOutcome = 'deleted' | 'rejected' | 'unknown' | 'unavailable';
export type PublicReplaceResult = Readonly<{
  outcome: PublicMutationOutcome;
  accountId?: string;
  detail?: ProviderCallDetail;
}>;

export type ProviderPrivateAccountMutationResult = Readonly<{
  status: PublicMutationOutcome | PublicDeleteOutcome;
  detail?: ProviderCallDetail;
  reason?: 'invalid-request' | 'rejected' | 'not-admitted' | 'outcome-unknown';
}>;

export type PrivateAccountAdmissionFailure = ProviderPrivateAccountMutationResult & (
  | Readonly<{ status: 'rejected'; reason: 'invalid-request' | 'rejected' | 'not-admitted' }>
  | Readonly<{ status: 'unknown'; reason: 'outcome-unknown' }>
);
export type PrivateAccountAdmissionResult = CallReceipt | PrivateAccountAdmissionFailure;

type ProviderMutationTransportResponse = Awaited<ReturnType<ProviderAccountsTransport['execute']>>;

export async function storeProviderPrivateAccount(
  deps: ProviderPrivateAccountDependencies,
  account: ProviderAccountIntent,
  apiKey?: unknown,
  token?: unknown,
): Promise<ProviderPrivateAccountMutationResult> {
  const transaction = await preparePrivateAccount(account, apiKey, token, deps.assertCurrent);
  const receipt = await admitPrivateAccount(deps.transport, transaction, account, deps.assertCurrent);
  return 'status' in receipt ? receipt
    : await accountCallResult(deps, receipt, 'providerAccounts.replace', account.id, account.revision);
}

export async function preparePrivateAccount(
  account: AccountIntent, apiKey?: unknown, token?: unknown, assertCurrent?: () => void,
): Promise<PrivateAccountTransaction> {
  if (!parseAccount(account)
    || apiKey !== undefined && (account.authMode !== 'apiKey' || !isSecret(apiKey))
    || token !== undefined && (account.authMode !== 'token' || !isSecret(token))) {
    throw new Error('Provider account request is invalid');
  }
  if (account.authMode === 'cliReuse' && account.enabled) {
    const status = await probeAnthropicCliAuth();
    if (status !== 'available') {
      throw new Error(status === 'missing'
        ? 'Claude CLI is not authenticated. Run claude auth login, then retry.'
        : 'Claude CLI authentication could not be verified. Run claude auth status, then retry.');
    }
  }
  const secret: PrivateCredential | undefined = apiKey !== undefined
    ? { kind: 'apiKey', provider: account.provider, key: apiKey as string }
    : token !== undefined
      ? { kind: 'token', provider: account.provider, token: normalizeProviderToken(account.provider, token as string) }
      : undefined;
  return preparePrivateAccountSecret(account, secret, assertCurrent);
}

async function preparePrivateAccountSecret(
  account: AccountIntent, secret?: PrivateCredential, assertCurrent?: () => void,
): Promise<PrivateAccountTransaction> {
  assertCurrent?.();
  const transaction = await beginPrivateAccountTransaction(account.id, account.revision, 'replace', settleCredential);
  try {
    assertCurrent?.();
    transaction.credentialRequired = account.authMode !== 'local' && account.authMode !== 'cliReuse';
    if (transaction.credentialRequired && secret) {
      assertCurrent?.();
      transaction.encryptedCredential = encryptSecret(secret);
    }
    return transaction;
  } catch (error) {
    await settlePrivateAccountTransaction(transaction, 'rejected', false, settleCredential);
    throw error;
  }
}

export async function commitPrivateAccount(
  deps: ProviderPrivateAccountDependencies,
  account: AccountIntent,
  secret: PrivateCredential,
  trackMutation: (mutate: () => Promise<PrivateAccountAdmissionResult>) => Promise<PrivateAccountAdmissionResult>,
): Promise<PublicReplaceResult> {
  const receipt = await trackMutation(async () => {
    const transaction = await preparePrivateAccountSecret(account, secret);
    return await admitPrivateAccount(deps.transport, transaction, account);
  });
  if ('status' in receipt) return { outcome: receipt.status };
  const result = await accountCallResult(deps, receipt, 'providerAccounts.replace', account.id, account.revision);
  return { outcome: result.status as PublicMutationOutcome, accountId: account.id, detail: result.detail };
}

function normalizeProviderToken(provider: string, token: string): string {
  if (provider !== 'anthropic') return token;
  const normalized = token.replace(/\s+/g, '');
  if (!normalized.startsWith('sk-ant-oat01-') || normalized.length < 80) {
    throw new Error('Paste the full Anthropic setup-token starting with sk-ant-oat01-.');
  }
  return normalized;
}

export async function deleteProviderPrivateAccount(
  deps: ProviderPrivateAccountDependencies,
  accountId: string,
  revision: number,
): Promise<ProviderPrivateAccountMutationResult> {
  const receipt = await admitPrivateDelete(deps.transport, accountId, revision, deps.assertCurrent);
  return 'status' in receipt ? receipt
    : await accountCallResult(deps, receipt, 'providerAccounts.delete', accountId, revision);
}

export async function admitPrivateAccount(
  transport: ProviderAccountsTransport, transaction: PrivateAccountTransaction, account: AccountIntent, assertCurrent?: () => void,
): Promise<PrivateAccountAdmissionResult> {
  return admitPrivateMutation(transport, transaction, 'providerAccounts.replace', {
    kind: 'replace', account, privateTransactionId: transaction.id,
  }, assertCurrent);
}

export async function admitPrivateDelete(
  transport: ProviderAccountsTransport, accountId: string, revision: number, assertCurrent?: () => void,
): Promise<PrivateAccountAdmissionResult> {
  if (!isId(accountId) || !isRevision(revision)) throw new Error('Provider account request is invalid');
  assertCurrent?.();
  const transaction = await beginPrivateAccountTransaction(accountId, revision, 'delete', settleCredential);
  return admitPrivateMutation(transport, transaction, 'providerAccounts.delete', {
    kind: 'delete', accountId, revision, privateTransactionId: transaction.id,
  }, assertCurrent);
}

async function admitPrivateMutation(
  transport: ProviderAccountsTransport,
  transaction: PrivateAccountTransaction,
  command: 'providerAccounts.replace' | 'providerAccounts.delete',
  input: unknown,
  assertCurrent?: () => void,
): Promise<PrivateAccountAdmissionResult> {
  try { assertCurrent?.(); }
  catch (error) {
    if (!transaction.claimed) await settlePrivateAccountTransaction(transaction, 'rejected', false, settleCredential);
    throw error;
  }
  let response: ProviderMutationTransportResponse;
  try { response = await transport.execute(accountRequest(command, input)); }
  catch { return { status: 'unknown', reason: 'outcome-unknown' }; }
  if (response.status === 202) {
    try { return decodeCallReceipt(response.body); }
    catch { return { status: 'unknown', reason: 'outcome-unknown' }; }
  }
  const notAdmitted = response.status === 400 || response.status === 422
    || response.status === 503 && 'code' in response.body && response.body.code === 'not-admitted';
  if (notAdmitted && !transaction.claimed) {
    try { await settlePrivateAccountTransaction(transaction, 'rejected', false, settleCredential); }
    catch { return { status: 'unknown', reason: 'outcome-unknown' }; }
    return {
      status: 'rejected',
      reason: response.status === 400 ? 'invalid-request' : response.status === 422 ? 'rejected' : 'not-admitted',
    };
  }
  return { status: 'unknown', reason: 'outcome-unknown' };
}

async function accountCallResult(
  deps: ProviderPrivateAccountDependencies,
  receipt: CallReceipt,
  command: 'providerAccounts.replace' | 'providerAccounts.delete',
  accountId: string,
  revision: number,
): Promise<ProviderPrivateAccountMutationResult> {
  let record: CallRecord<'provider'>;
  try { record = await deps.awaitProviderCall(receipt, command); }
  catch { return { status: 'unknown' }; }
  const detail = record.detail;
  if (record.callId !== receipt.callId || record.module !== 'provider' || record.command !== command
    || detail.kind !== (command === 'providerAccounts.replace' ? 'replaceAccount' : 'deleteAccount')
    || detail.phase !== 'terminal' || detail.accountId !== accountId || detail.accountRevision !== revision) {
    return { status: 'unknown' };
  }
  providerPrivateAuthTrace('mutation.terminal', () => ({ command, ...detailTrace(detail) }));
  if (detail.diagnostic?.reason === 'private-transaction-settle-failed') return { status: 'unknown', detail };
  const outcome = command === 'providerAccounts.replace' ? 'stored' : 'deleted';
  if (detail.outcome === outcome && detail.persisted === 'confirmed' && detail.commit === 'committed') {
    return { status: outcome, detail };
  }
  return {
    status: detail.outcome === 'rejected' || record.status === 'rejected' ? 'rejected'
      : detail.outcome === 'unavailable' ? 'unavailable' : 'unknown',
    detail,
  };
}

function accountRequest(operationId: 'providerAccounts.replace' | 'providerAccounts.delete', input: unknown): unknown {
  return {
    id: 'provider.accounts',
    operationId,
    scope: { kind: 'provider-account-catalog' },
    target: { kind: 'provider-accounts' },
    input,
  };
}
