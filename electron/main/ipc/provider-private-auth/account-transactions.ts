import { randomUUID } from 'node:crypto';

type Settlement = 'retained' | 'rejected' | 'unknown';
export type PrivateAccountTransaction = {
  readonly id: string;
  readonly reference: string;
  readonly revision: number;
  previous?: string;
  claimed: boolean;
  rollbackPending?: boolean;
  settlement?: Settlement;
  settling?: { outcome: Settlement; promise: Promise<void> };
};

const transactions = new Map<string, PrivateAccountTransaction>();
const locks = new Map<string, string>();
const MAX_TRANSACTIONS = 256;

export async function beginPrivateAccountTransaction(
  reference: string,
  revision: number,
  snapshot: () => Promise<string | undefined>,
  restore: (reference: string, previous: string | undefined) => Promise<void>,
): Promise<PrivateAccountTransaction> {
  const pending = transactions.get(locks.get(reference) ?? '');
  if (pending?.rollbackPending) {
    await settlePrivateAccountTransaction(pending, 'rejected', restore);
  }
  for (const [id, transaction] of transactions) {
    if (transactions.size < MAX_TRANSACTIONS) break;
    if (transaction.settlement !== undefined) transactions.delete(id);
  }
  for (const [id, transaction] of transactions) {
    if (transactions.size < MAX_TRANSACTIONS) break;
    if (!transaction.rollbackPending) continue;
    await settlePrivateAccountTransaction(transaction, 'rejected', restore);
    transactions.delete(id);
  }
  if (locks.has(reference)) throw new Error('Provider account mutation is already pending; reopen before retrying');
  if (transactions.size >= MAX_TRANSACTIONS) throw new Error('Provider account mutations are unavailable');
  const transaction: PrivateAccountTransaction = { id: randomUUID(), reference, revision, claimed: false };
  locks.set(reference, transaction.id);
  transactions.set(transaction.id, transaction);
  try {
    transaction.previous = await snapshot();
    return transaction;
  } catch (error) {
    transactions.delete(transaction.id);
    locks.delete(reference);
    throw error;
  }
}

export function privateAccountTransactionForRequest(
  id: string, reference: string, revision: number,
): PrivateAccountTransaction | undefined {
  const transaction = transactions.get(id);
  return transaction?.reference === reference && transaction.revision === revision ? transaction : undefined;
}

export function claimPrivateAccountTransaction(transaction: PrivateAccountTransaction): boolean {
  if (transaction.settlement !== undefined || transaction.settling !== undefined || transaction.rollbackPending) return false;
  transaction.claimed = true;
  return true;
}

export async function settlePrivateAccountTransaction(
  transaction: PrivateAccountTransaction,
  outcome: Settlement,
  restore: (reference: string, previous: string | undefined) => Promise<void>,
): Promise<void> {
  if (transaction.settlement !== undefined) {
    if (transaction.settlement !== outcome) throw new Error('Provider private transaction settlement conflicts');
    return;
  }
  if (transaction.settling) {
    if (transaction.settling.outcome !== outcome) throw new Error('Provider private transaction settlement conflicts');
    return transaction.settling.promise;
  }
  if (transaction.rollbackPending && outcome !== 'rejected') throw new Error('Provider private transaction settlement conflicts');
  const promise = (async () => {
    if (outcome === 'rejected') {
      transaction.rollbackPending = true;
      await restore(transaction.reference, transaction.previous);
    }
    transaction.settlement = outcome;
    transaction.rollbackPending = false;
    transaction.previous = undefined;
    locks.delete(transaction.reference);
  })();
  transaction.settling = { outcome, promise };
  try { await promise; } finally { transaction.settling = undefined; }
}

export async function closePrivateAccountTransactions(
  restore: (reference: string, previous: string | undefined) => Promise<void>,
): Promise<void> {
  for (const transaction of transactions.values()) {
    if (transaction.rollbackPending) {
      await settlePrivateAccountTransaction(transaction, 'rejected', restore);
    }
  }
  clearPrivateAccountTransactions();
}

export function clearPrivateAccountTransactions(): void {
  transactions.clear();
  locks.clear();
}
