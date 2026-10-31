import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { platform } from 'node:process';
import { app, safeStorage } from 'electron';
import { MAX_SECRET_BYTES, isCredentialReference, isProviderName, isRevision, isSecret } from './account-intent';
import { ProviderPrivateResolverError } from './credential-error';
import { claimPrivateAccountTransaction, ownsCredentialReference, runPrivateAccountEffect, type PrivateAccountTransaction } from './account-transactions';

const STORE_FILE = 'provider-private-auth.v1.json';
type PrivateStore = Record<string, string>;
let privateStoreWrite = Promise.resolve();
export type PrivateCredential = ReturnType<typeof parsePrivateCredential>;

export async function drainPrivateCredentials(): Promise<void> { await privateStoreWrite; }

export async function settleCredential(
  transaction: PrivateAccountTransaction, outcome: 'retained' | 'rejected' | 'unknown', committed: boolean,
): Promise<void> {
  await updatePrivateStore((store) => {
    if (outcome === 'rejected') delete store[transaction.credentialReference];
    else if (committed) {
      const retained = transaction.kind === 'replace' && transaction.credentialRequired
        ? transaction.credentialReference : undefined;
      for (const reference of Object.keys(store)) {
        if (ownsCredentialReference(transaction.accountId, reference) && reference !== retained) delete store[reference];
      }
    }
  });
}

export async function claimPrivateCredential(transaction: PrivateAccountTransaction, previousReference: string | undefined): Promise<void> {
  if (previousReference !== undefined && !ownsCredentialReference(transaction.accountId, previousReference)) {
    throw new ProviderPrivateResolverError('invalid-request');
  }
  if (transaction.claimed && transaction.previousReference !== previousReference) throw new ProviderPrivateResolverError('invalid-request');
  if (!claimPrivateAccountTransaction(transaction)) throw new ProviderPrivateResolverError('invalid-request');
  transaction.previousReference = previousReference;
  await runPrivateAccountEffect(transaction.accountId, transaction.credentialReference, transaction.revision, transaction.id, async () => {
    await updatePrivateStore((store) => {
      if (transaction.kind === 'replace' && transaction.credentialRequired && !store[transaction.credentialReference]) {
        const credential = transaction.encryptedCredential ?? (previousReference && store[previousReference]);
        if (!credential) throw new ProviderPrivateResolverError('credential-missing');
        store[transaction.credentialReference] = credential;
      }
      for (const reference of Object.keys(store)) {
        if (ownsCredentialReference(transaction.accountId, reference)
          && reference !== previousReference && reference !== transaction.credentialReference) delete store[reference];
      }
    });
  });
}

export function encryptSecret(secret: unknown): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Provider credential storage is unavailable');
  const serialized = JSON.stringify(secret);
  if (Buffer.byteLength(serialized) > MAX_SECRET_BYTES) throw new Error('Provider credential request is invalid');
  return safeStorage.encryptString(serialized).toString('base64');
}

export async function storeSecret(reference: string, secret: unknown): Promise<string> {
  const encrypted = encryptSecret(secret);
  await updatePrivateStore((store) => {
    if (store[reference] !== undefined) throw new ProviderPrivateResolverError('invalid-request');
    store[reference] = encrypted;
  });
  return reference;
}

export async function resolvePrivateCredential(reference: string): Promise<string | undefined> {
  const encrypted = (await readStore())[reference];
  if (!encrypted) return undefined;
  const credential = parsePrivateCredential(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
  if (credential.kind === 'apiKey') return credential.key;
  if (credential.kind === 'token') return credential.token;
  return credential.access;
}

export function readPrivateCredential(reference: string): Promise<string> {
  return readStore().then((store) => {
    const encrypted = store[reference];
    if (!encrypted) throw new ProviderPrivateResolverError('credential-missing');
    return encrypted;
  }, (error) => {
    throw new ProviderPrivateResolverError('credential-store-unavailable', error);
  });
}

export function decryptPrivateCredential(encrypted: string): ReturnType<typeof parsePrivateCredential> {
  try {
    return parsePrivateCredential(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
  } catch (error) {
    throw new ProviderPrivateResolverError('credential-decrypt-failed', error);
  }
}

function parsePrivateCredential(value: string):
  | Readonly<{ kind: 'apiKey'; provider: string; key: string }>
  | Readonly<{ kind: 'token'; provider: string; token: string }>
  | Readonly<{
    kind: 'oauth';
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
    clientId?: string;
    enterpriseUrl?: string;
    projectId?: string;
    chatgptPlanType?: string;
    idToken?: string;
    email?: string;
    displayName?: string;
  }> {
  const credential: unknown = JSON.parse(value);
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new Error('Provider credential is invalid');
  }
  const candidate = credential as Record<string, unknown>;
  if (candidate.kind === 'apiKey' && isProviderName(candidate.provider) && isSecret(candidate.key)) {
    return { kind: 'apiKey', provider: candidate.provider, key: candidate.key };
  }
  if (candidate.kind === 'token' && isProviderName(candidate.provider) && isSecret(candidate.token)) {
    return { kind: 'token', provider: candidate.provider, token: candidate.token };
  }
  if (candidate.kind === 'oauth'
    && isSecret(candidate.access)
    && isSecret(candidate.refresh)
    && isRevision(candidate.expires)) {
    return {
      kind: 'oauth',
      access: candidate.access,
      refresh: candidate.refresh,
      expires: candidate.expires,
      ...optionalCredentialText(candidate, 'accountId'),
      ...optionalCredentialText(candidate, 'clientId'),
      ...optionalCredentialText(candidate, 'enterpriseUrl'),
      ...optionalCredentialText(candidate, 'projectId'),
      ...optionalCredentialText(candidate, 'chatgptPlanType'),
      ...optionalCredentialText(candidate, 'idToken'),
      ...optionalCredentialText(candidate, 'email'),
      ...optionalCredentialText(candidate, 'displayName'),
    };
  }
  throw new Error('Provider credential is invalid');
}

function optionalCredentialText(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  return typeof value === 'string' ? { [key]: value } : {};
}

export async function removeCredentialReference(reference: string): Promise<void> {
  await updatePrivateStore((store) => {
    delete store[reference];
  });
}

function storePath(): string { return join(app.getPath('userData'), STORE_FILE); }

export async function readStore(): Promise<PrivateStore> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return Object.fromEntries(Object.entries(value).filter(([key, encrypted]) => isCredentialReference(key) && typeof encrypted === 'string'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Provider credential storage is unavailable', { cause: error });
  }
}

export async function updatePrivateStore(mutate: (store: PrivateStore) => void): Promise<void> {
  const previous = privateStoreWrite;
  let release!: () => void;
  privateStoreWrite = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const store = await readStore();
    mutate(store);
    await replacePrivateFile(storePath(), JSON.stringify(store));
  } finally {
    release();
  }
}

async function replacePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.writeFile(contents, { encoding: 'utf8' });
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncContainingDirectory(path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncContainingDirectory(path: string): Promise<void> {
  if (platform === 'win32') return;
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
