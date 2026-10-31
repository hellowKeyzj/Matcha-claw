import { createHash, randomUUID } from 'node:crypto';

type Settlement = 'retained' | 'rejected' | 'unknown';
export type PrivateAccountTransaction = {
  readonly id: string;
  readonly accountId: string;
  readonly reference: string;
  readonly credentialReference: string;
  readonly revision: number;
  readonly kind: 'replace' | 'delete';
  previousReference?: string;
  credentialRequired?: boolean;
  encryptedCredential?: string;
  claimed: boolean;
  rollbackPending?: boolean;
  settlement?: Settlement;
  settling?: { outcome: Settlement; committed: boolean; promise: Promise<void> };
};

type Settle = (transaction: PrivateAccountTransaction, outcome: Settlement, committed: boolean) => Promise<void>;
const transactions = new Map<string, PrivateAccountTransaction>();
const locks = new Map<string, string>();
const effects = new Map<string, Promise<void>>();
let recovery: Promise<void> | undefined;
const MAX_TRANSACTIONS = 256;

export function accountCredentialPrefix(accountId: string): string {
  return `credential:v1:provider:${createHash('sha256').update(accountId).digest('hex')}:`;
}

export function isVersionedProviderCredentialReference(reference: string): boolean {
  return /^credential:v1:provider:[a-f0-9]{64}:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reference);
}

export function ownsCredentialReference(accountId: string, reference: string): boolean {
  return isVersionedProviderCredentialReference(reference)
    ? reference.startsWith(accountCredentialPrefix(accountId))
    : reference === `credential:v1:${accountId}`;
}

export async function beginPrivateAccountTransaction(
  accountId: string, revision: number, kind: 'replace' | 'delete', settle: Settle,
): Promise<PrivateAccountTransaction> {
  if (recovery) throw new Error('Provider account mutations are unavailable');
  const reference = `credential:v1:${accountId}`;
  const pending = transactions.get(locks.get(reference) ?? '');
  if (pending?.rollbackPending) {
    await settlePrivateAccountTransaction(pending, 'rejected', false, settle);
    if (recovery || transactions.get(pending.id) !== pending) throw new Error('Provider account mutations are unavailable');
  }
  for (const [id, transaction] of transactions) {
    if (transactions.size < MAX_TRANSACTIONS) break;
    if (transaction.settlement !== undefined) transactions.delete(id);
  }
  if (locks.has(reference)) throw new Error('Provider account mutation is already pending; reopen before retrying');
  if (transactions.size >= MAX_TRANSACTIONS) throw new Error('Provider account mutations are unavailable');
  const id = randomUUID();
  const transaction: PrivateAccountTransaction = {
    id, accountId, reference, credentialReference: `${accountCredentialPrefix(accountId)}${id}`,
    revision, kind, claimed: false,
  };
  locks.set(reference, id);
  transactions.set(id, transaction);
  return transaction;
}

export function privateAccountTransactionForRequest(
  id: string, reference: string, revision: number,
): PrivateAccountTransaction | undefined {
  const transaction = transactions.get(id);
  return transaction?.reference === reference && transaction.revision === revision ? transaction : undefined;
}

export function claimPrivateAccountTransaction(transaction: PrivateAccountTransaction): boolean {
  if (recovery || transaction.settlement !== undefined || transaction.settling !== undefined || transaction.rollbackPending) return false;
  transaction.claimed = true;
  return true;
}

export function runPrivateAccountEffect<T>(
  accountId: string, reference: string, revision: number, transactionId: string | undefined,
  effect: () => Promise<T>,
): Promise<T> {
  const transaction = transactions.get(locks.get(`credential:v1:${accountId}`) ?? '');
  if (recovery || !ownsCredentialReference(accountId, reference)
    || transactionId !== undefined && transaction?.id !== transactionId
    || transaction && (!transaction.claimed || transaction.settlement !== undefined || transaction.settling !== undefined
      || transactionId !== undefined && transaction.revision !== revision
      || transactionId === undefined && reference !== transaction.credentialReference
      || reference !== transaction.credentialReference && reference !== transaction.previousReference)) {
    throw new Error('Provider private effect is not eligible');
  }
  const operation = (effects.get(accountId) ?? Promise.resolve()).then(effect);
  const drained = operation.then(() => undefined, () => undefined);
  effects.set(accountId, drained);
  void drained.then(() => { if (effects.get(accountId) === drained) effects.delete(accountId); });
  return operation;
}

export async function settlePrivateAccountTransaction(
  transaction: PrivateAccountTransaction, outcome: Settlement, committed: boolean, settle: Settle,
): Promise<void> {
  if (transaction.settlement !== undefined) {
    if (transaction.settlement !== outcome) throw new Error('Provider private transaction settlement conflicts');
    return;
  }
  if (transaction.settling) {
    if (transaction.settling.outcome !== outcome || transaction.settling.committed !== committed) {
      throw new Error('Provider private transaction settlement conflicts');
    }
    return transaction.settling.promise;
  }
  if (transaction.rollbackPending && outcome !== 'rejected') throw new Error('Provider private transaction settlement conflicts');
  const promise = Promise.resolve().then(async () => {
    await effects.get(transaction.accountId);
    if (outcome === 'rejected') transaction.rollbackPending = true;
    await settle(transaction, outcome, committed);
    transaction.settlement = outcome;
    transaction.rollbackPending = false;
    transaction.previousReference = undefined;
    transaction.encryptedCredential = undefined;
    if (locks.get(transaction.reference) === transaction.id) locks.delete(transaction.reference);
  });
  // Seal admission before awaiting the real SQL/vault tail, not the HTTP observer.
  transaction.settling = { outcome, committed, promise };
  try { await promise; } finally { transaction.settling = undefined; }
}

export function isPrivateAccountRecoveryActive(): boolean {
  return recovery !== undefined;
}

export function recoverPrivateAccountTransactions(reconcile: () => Promise<void>): Promise<void> {
  // Seal admission synchronously, before draining the original effects and settlements.
  recovery ??= Promise.resolve().then(async () => {
    const settlements: Promise<void>[] = [];
    for (const transaction of transactions.values()) {
      if (transaction.settling) settlements.push(transaction.settling.promise);
      else transaction.settlement ??= 'unknown';
    }
    const drained = await Promise.allSettled([...effects.values(), ...settlements]);
    for (const result of drained) {
      if (result.status === 'rejected') throw result.reason;
    }
    clearPrivateAccountTransactions();
    await reconcile();
  }).finally(() => { recovery = undefined; });
  return recovery;
}

export async function closePrivateAccountTransactions(settle: Settle): Promise<void> {
  await Promise.all(effects.values());
  for (const transaction of transactions.values()) {
    if (transaction.settling) await transaction.settling.promise;
    if (transaction.rollbackPending) await settlePrivateAccountTransaction(transaction, 'rejected', false, settle);
  }
  clearPrivateAccountTransactions();
}

export function clearPrivateAccountTransactions(): void {
  transactions.clear();
  locks.clear();
  effects.clear();
}
