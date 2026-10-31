import { traceDebug, isTraceEnabled } from '../../utils/trace-logger';
import { summarizeIdentifier } from '../runtime-host-delivery/transport/sessions/trace';
import { isAuthMode, isCredentialReference, isId, isProfileProviderName, isProviderName, isRecord, isRevision, isTransactionId } from './account-intent';
import { beginPrivateAccountTransaction, closePrivateAccountTransactions, isPrivateAccountRecoveryActive, isVersionedProviderCredentialReference, ownsCredentialReference, privateAccountTransactionForRequest, recoverPrivateAccountTransactions, runPrivateAccountEffect, settlePrivateAccountTransaction } from './account-transactions';
import { claimPrivateCredential, drainPrivateCredentials, removeCredentialReference, resolvePrivateCredential, settleCredential, updatePrivateStore } from './credentials';
import { ProviderPrivateResolverError } from './credential-error';
import { applyPrivateProfile, deletePrivateAccount, removePrivateProfile } from './openclaw/auth-profile';
import { AuthProfileSqliteError, AuthProfileSqliteWriter } from './openclaw/auth-profile-sqlite';

type ProviderCredentialResponse = Readonly<{ status: number; body?: unknown }>;

export async function createProviderPrivateCredentialAdapter(openClawStateDir: string) {
  const authProfiles = await AuthProfileSqliteWriter.start(openClawStateDir);
  const resolve = async (method: string, body: Record<string, unknown> | undefined): Promise<ProviderCredentialResponse> => {
    if (method === 'POST' && body?.operation === 'recover') {
      if (Object.keys(body).sort().join(',') !== 'accounts,operation' || !Array.isArray(body.accounts)
        || !body.accounts.every((account: unknown) => isRecord(account) && Object.keys(account).sort().join(',') === 'accountId,reference'
          && isId(account.accountId) && isCredentialReference(account.reference) && ownsCredentialReference(account.accountId, account.reference))) {
        return { status: 400, body: { error: 'invalid-request' } };
      }
      const retained = new Set(body.accounts.map((account: { reference: string }) => account.reference));
      try {
        await recoverPrivateAccountTransactions(() => updatePrivateStore((store) => {
          for (const reference of Object.keys(store)) {
            if (isVersionedProviderCredentialReference(reference) && !retained.has(reference)) delete store[reference];
          }
        }));
        return { status: 204 };
      } catch { return { status: 503, body: { error: 'credential-store-unavailable' } }; }
    }
    if (isPrivateAccountRecoveryActive()) {
      return { status: 503, body: { error: 'credential-store-unavailable' } };
    }
    if (method === 'POST' && body?.operation === 'begin') {
      if (Object.keys(body).sort().join(',') !== 'accountId,credentialRequired,kind,operation,revision'
        || !isId(body.accountId) || !isRevision(body.revision)
        || (body.kind !== 'replace' && body.kind !== 'delete') || typeof body.credentialRequired !== 'boolean'
        || body.kind === 'delete' && body.credentialRequired) {
        return { status: 400, body: { error: 'invalid-request' } };
      }
      try {
        const transaction = await beginPrivateAccountTransaction(body.accountId, body.revision, body.kind, settleCredential);
        transaction.credentialRequired = body.credentialRequired;
        return { status: 200, body: { transactionId: transaction.id } };
      } catch {
        return { status: 503, body: { error: 'credential-store-unavailable' } };
      }
    }
    const reference = body && isCredentialReference(body.reference) ? body.reference : undefined;
    const revision = body && isRevision(body.revision) ? body.revision : undefined;
    const profileProvider = body && isProfileProviderName(body.provider) ? body.provider : undefined;
    const resolving = isTraceEnabled() && method === 'POST'
      && (!body || !Object.hasOwn(body, 'revision') && !Object.hasOwn(body, 'operation'));
    const started = resolving ? performance.now() : undefined;
    const traceResolve = (stage: string, payload: () => Record<string, unknown>): void => {
      if (!resolving) return;
      traceDebug(() => JSON.stringify({
        prefix: 'session-trace', source: 'electron-main', stage, at: Date.now(),
        referenceHash: summarizeIdentifier(reference).hash,
        referencePresent: body?.reference !== undefined,
        referenceValid: reference !== undefined,
        elapsedMs: started === undefined ? undefined : performance.now() - started,
        ...payload(),
      }));
    };
    traceResolve('electron.private-credential.resolve.request', () => ({}));
    if (!reference || !isPrivateResolverRequest(method, body)) {
      traceResolve('electron.private-credential.resolve.result', () => ({
        outcome: 'invalid-input', code: 'invalid-request', status: 400,
      }));
      return { status: 400, body: { error: 'invalid-request' } };
    }
    try {
      if (body?.operation === 'claim' || body?.operation === 'settle') {
        const transaction = privateAccountTransactionForRequest(body.transactionId as string, reference, revision!);
        if (!transaction) throw new ProviderPrivateResolverError('invalid-request');
        if (body.operation === 'claim') {
          await claimPrivateCredential(transaction, body.previousReference as string | undefined);
        } else {
          await settlePrivateAccountTransaction(transaction, body.settlement as 'retained' | 'rejected' | 'unknown', body.committed === true, settleCredential);
        }
        return { status: 204 };
      } else if (method === 'DELETE') {
        if (!revision || !profileProvider) {
          return { status: 400, body: { error: 'invalid-request' } };
        }
        const accountId = body!.accountId as string;
        const transactionId = body!.transactionId as string;
        await runPrivateAccountEffect(accountId, reference, revision, transactionId, () => deletePrivateAccount(reference, accountId, profileProvider, authProfiles));
        return { status: 204 };
      } else if (method === 'PUT') {
        if (!revision || !profileProvider) {
          return { status: 400, body: { error: 'invalid-request' } };
        }
        await runPrivateAccountEffect(body!.accountId as string, reference, revision, body!.transactionId as string, async () => {
          await removePrivateProfile(reference, body!.accountId as string, profileProvider, authProfiles);
          await removeCredentialReference(reference);
        });
        return { status: 204 };
      } else if (!revision) {
        traceResolve('electron.private-credential.resolve.branch', () => ({ outcome: 'lookup' }));
        const value = await resolvePrivateCredential(reference);
        if (value === undefined) {
          traceResolve('electron.private-credential.resolve.result', () => ({ outcome: 'not-found', status: 404 }));
          return { status: 404 };
        }
        traceResolve('electron.private-credential.resolve.result', () => ({ outcome: 'resolved', status: 200 }));
        return { status: 200, body: { value } };
      } else {
        if (!body) {
          return { status: 400, body: { error: 'invalid-request' } };
        }
        const provider = isProfileProviderName(body.provider) ? body.provider : undefined;
        const credentialProvider = isProviderName(body.credentialProvider) ? body.credentialProvider : undefined;
        const authMode = isAuthMode(body.authMode) ? body.authMode : undefined;
        if (!provider || !credentialProvider || !authMode || authMode === 'local' || authMode === 'cliReuse') {
          return { status: 400, body: { error: 'invalid-request' } };
        }
        await runPrivateAccountEffect(body.accountId as string, reference, revision, body.transactionId as string | undefined,
          () => applyPrivateProfile(reference, body.accountId as string, provider, credentialProvider, authMode, authProfiles));
        return { status: 204 };
      }
    } catch (error) {
      traceResolve('electron.private-credential.resolve.result', () => ({
        outcome: 'private-error', status: 503,
        code: (error instanceof ProviderPrivateResolverError || error instanceof AuthProfileSqliteError) && [
          'invalid-request', 'credential-missing', 'credential-decrypt-failed',
          'credential-provider-mismatch', 'credential-invalid', 'auth-profile-read-invalid',
          'auth-profile-write-failed', 'credential-store-unavailable', 'unknown',
        ].includes(error.code) ? error.code : 'unknown',
      }));
      return { status: 503, body: { error: error instanceof ProviderPrivateResolverError || error instanceof AuthProfileSqliteError ? error.code : 'unknown' } };
    }
  };
  return {
    resolve,
    drainCredentials: drainPrivateCredentials,
    closeTransactions: () => closePrivateAccountTransactions(settleCredential),
    close: () => authProfiles.close(),
  };
}

function isPrivateResolverRequest(
  method: string,
  body: Record<string, unknown> | undefined,
): boolean {
  if (!body) return false;
  const keys = Object.keys(body).sort();
  if (method === 'POST' && (body.operation === 'claim' || body.operation === 'settle')) {
    return keys.join(',') === (body.operation === 'claim'
      ? (body.previousReference === undefined ? 'operation,reference,revision,transactionId' : 'operation,previousReference,reference,revision,transactionId')
      : 'committed,operation,reference,revision,settlement,transactionId')
      && isTransactionId(body.transactionId) && isRevision(body.revision)
      && (body.operation === 'claim'
        ? body.previousReference === undefined || isCredentialReference(body.previousReference)
        : typeof body.committed === 'boolean' && (body.settlement === 'retained' || body.settlement === 'rejected' || body.settlement === 'unknown'));
  }
  if (method === 'POST' && keys.join(',') === 'reference') return true;
  const effectKeys = method === 'POST'
    ? 'accountId,authMode,credentialProvider,provider,reference,revision'
    : 'accountId,provider,reference,revision';
  return keys.join(',') === (body.transactionId === undefined ? effectKeys : `${effectKeys},transactionId`)
    && isId(body.accountId) && isRevision(body.revision)
    && (method === 'POST' && body.transactionId === undefined || isTransactionId(body.transactionId));
}
