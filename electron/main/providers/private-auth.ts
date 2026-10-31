import type { BrowserWindow } from 'electron';
import { isId, isRevision, isSecret, parseAccount } from './account-intent';
import { admitPrivateAccount, admitPrivateDelete, preparePrivateAccount, type PrivateAccountAdmissionFailure, type ProviderPrivateAccountDependencies } from './accounts';
import { ownsCredentialReference } from './account-transactions';
import { readStore } from './credentials';
import { createProviderOAuthActions } from './oauth/flows';
import { accountTrace, idShape, providerPrivateAuthTrace } from './trace';

export type { ProviderAccountIntent } from './account-intent';
export type { AwaitProviderCall, ProviderPrivateAccountDependencies, ProviderPrivateAccountMutationResult } from './accounts';
export { storeProviderPrivateAccount, deleteProviderPrivateAccount } from './accounts';
export { createProviderCallObserver } from './call-observation';
export { migrateLegacyProviderPrivateAuth } from './migration';
export { createProviderPrivateCredentialAdapter } from './resolver';

export type ProviderPrivateAuthActions = Pick<ReturnType<typeof createProviderPrivateAuth>,
  'storeAccount' | 'deleteAccount' | 'startOAuth' | 'submitOAuthCode' | 'cancelOAuth'>;

export type ProviderCredentialStatusResponse = Readonly<{ hasKey: boolean }>;

export interface ProviderCredentialStatusTransport {
  hasApiKey(accountId: string): Promise<ProviderCredentialStatusResponse>;
}

export function createProviderCredentialStatusTransport(): ProviderCredentialStatusTransport {
  return {
    async hasApiKey(accountId: string): Promise<ProviderCredentialStatusResponse> {
      if (!isId(accountId)) throw new Error('Provider account request is invalid');
      const store = await readStore();
      return { hasKey: Object.keys(store).some((reference) => ownsCredentialReference(accountId, reference)) };
    },
  };
}

export function createProviderPrivateAuth(
  getMainWindow: () => BrowserWindow | null,
  runtime: Promise<ProviderPrivateAccountDependencies>,
  signal: AbortSignal,
) {
  const mutations = new Set<Promise<unknown>>();
  const trackMutation = <T>(mutate: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const task = Promise.resolve().then(mutate);
    mutations.add(task);
    return task.finally(() => { mutations.delete(task); });
  };
  void runtime.catch(() => undefined);
  const storeAccount = async (input: unknown) => {
    const value = input as { account?: unknown; apiKey?: unknown; token?: unknown };
    providerPrivateAuthTrace('ipc.store.received', () => ({
      hasAccount: Boolean(value?.account),
      privateAuthInputPresent: (typeof value?.apiKey === 'string' && value.apiKey.trim().length > 0)
        || (typeof value?.token === 'string' && value.token.trim().length > 0),
    }));
    const account = parseAccount(value?.account);
    if (!account
      || value.apiKey !== undefined && (account.authMode !== 'apiKey' || !isSecret(value.apiKey))
      || value.token !== undefined && (account.authMode !== 'token' || !isSecret(value.token))) {
      providerPrivateAuthTrace('ipc.store.rejected', () => ({ detail: 'invalid-account' }));
      return { status: 'rejected', reason: 'invalid-request' } satisfies PrivateAccountAdmissionFailure;
    }
    providerPrivateAuthTrace('ipc.store.decoded', () => (accountTrace(account)));
    try {
      const { transport } = await runtime;
      return await trackMutation(async () => {
        const transaction = await preparePrivateAccount(account, value.apiKey, value.token);
        return await admitPrivateAccount(transport, transaction, account);
      });
    } catch {
      return { status: 'unknown', reason: 'outcome-unknown' } satisfies PrivateAccountAdmissionFailure;
    }
  };

  const deleteAccount = async (input: unknown) => {
    const value = input as { accountId?: unknown; revision?: unknown };
    providerPrivateAuthTrace('ipc.delete.received', () => ({
      accountId: idShape(typeof value?.accountId === 'string' ? value.accountId : undefined),
      revision: typeof value?.revision === 'number' ? value.revision : undefined,
    }));
    if (!isId(value?.accountId) || !isRevision(value?.revision)) {
      providerPrivateAuthTrace('ipc.delete.rejected', () => ({ detail: 'invalid-request' }));
      return { status: 'rejected', reason: 'invalid-request' } satisfies PrivateAccountAdmissionFailure;
    }
    const { accountId, revision } = value;
    try {
      const { transport } = await runtime;
      return await trackMutation(() => admitPrivateDelete(transport, accountId, revision));
    } catch {
      return { status: 'unknown', reason: 'outcome-unknown' } satisfies PrivateAccountAdmissionFailure;
    }
  };

  const oauth = createProviderOAuthActions(getMainWindow, runtime, signal, trackMutation);
  return { storeAccount, deleteAccount, ...oauth, drain: async () => {
    await oauth.drain();
    await Promise.allSettled(mutations);
  } };
}
