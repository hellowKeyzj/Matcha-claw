import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  REMOTE_FLEET_CREDENTIAL_TEXT_LIMIT,
  isRemoteFleetWritableCredentialName,
  isValidRemoteFleetCredentialPathSegment,
  type RemoteFleetWritableCredentialName,
} from './remote-fleet-credential-host-rpc';
import type { RemoteFleetSecretResolveRequestInput } from './remote-fleet-secret-host-rpc';
import { REMOTE_FLEET_SECRET_REF_SCHEME, evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';
import type { RemoteFleetSecretRef } from './remote-fleet-model';

export type RemoteFleetCredentialResolveResult =
  | { readonly resultType: 'resolved'; readonly secretRef: string; readonly plaintextSecretValue: string }
  | { readonly resultType: 'notFound'; readonly secretRef: string }
  | { readonly resultType: 'accessDenied'; readonly secretRef: string }
  | { readonly resultType: 'unavailable' };

export interface RemoteFleetCredentialWriteInput {
  readonly operationId: string;
  readonly credentialId: string;
  readonly credentialName: RemoteFleetWritableCredentialName;
  readonly plaintextValue: string;
  readonly nowIso: string;
}

export type RemoteFleetCredentialWriteResult =
  | {
      readonly resultType: 'written';
      readonly credentialName: RemoteFleetWritableCredentialName;
      readonly credentialRef: RemoteFleetSecretRef;
      readonly writtenAt: string;
    }
  | { readonly resultType: 'operationConflict' };

export interface RemoteFleetCredentialWriteReceiptLookupInput {
  readonly operationId: string;
  readonly credentialName: RemoteFleetWritableCredentialName;
  readonly credentialRef: RemoteFleetSecretRef;
}

export type RemoteFleetCredentialWriteReceiptLookupResult =
  | { readonly resultType: 'completed'; readonly credentialName: RemoteFleetWritableCredentialName; readonly credentialRef: RemoteFleetSecretRef; readonly writtenAt: string }
  | { readonly resultType: 'notFound' }
  | { readonly resultType: 'operationConflict' };

export interface RemoteFleetCredentialStore {
  writeCredential(input: RemoteFleetCredentialWriteInput): Promise<RemoteFleetCredentialWriteResult>;
  lookupWriteReceipt(input: RemoteFleetCredentialWriteReceiptLookupInput): Promise<RemoteFleetCredentialWriteReceiptLookupResult>;
  resolveSecret(input: RemoteFleetSecretResolveRequestInput): Promise<RemoteFleetCredentialResolveResult>;
}

export interface RemoteFleetSecretResolverLike {
  resolveSecret(input: RemoteFleetSecretResolveRequestInput):
    | Promise<RemoteFleetCredentialResolveResult>
    | RemoteFleetCredentialResolveResult;
}

interface RemoteFleetCredentialPersistedState {
  readonly version: 1;
  readonly credentials: Record<string, RemoteFleetCredentialRecord>;
  readonly writeReceipts: Record<string, RemoteFleetCredentialWriteReceiptRecord>;
}

interface RemoteFleetCredentialWriteReceiptRecord {
  readonly version: 1;
  readonly operationId: string;
  readonly credentialName: RemoteFleetWritableCredentialName;
  readonly credentialRef: string;
  readonly writtenAt: string;
}

interface RemoteFleetCredentialRecord {
  readonly version: 1;
  readonly credentialName: RemoteFleetWritableCredentialName;
  readonly secretRef: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const REMOTE_FLEET_CREDENTIAL_KEY_BYTES = 32;
const REMOTE_FLEET_CREDENTIAL_IV_BYTES = 12;
const REMOTE_FLEET_CREDENTIAL_CIPHER = 'aes-256-gcm';
const credentialWriteQueues = new Map<string, Promise<void>>();

export function buildRemoteFleetCredentialSecretRef(
  credentialId: string,
  credentialName: RemoteFleetWritableCredentialName,
): RemoteFleetSecretRef {
  const credentialIdSegment = credentialId.trim();
  if (!isValidRemoteFleetCredentialPathSegment(credentialIdSegment)) {
    throw new Error('Remote Fleet credential id is not valid for a secret reference.');
  }
  return {
    kind: 'secret-ref',
    ref: `${REMOTE_FLEET_SECRET_REF_SCHEME}credentials/${credentialIdSegment}/${credentialName}`,
  };
}

export function createRemoteFleetChainedSecretResolver(
  resolvers: readonly RemoteFleetSecretResolverLike[],
): RemoteFleetSecretResolverLike {
  return {
    async resolveSecret(input) {
      let missingResult: Extract<RemoteFleetCredentialResolveResult, { readonly resultType: 'notFound' }> | undefined;
      for (const resolver of resolvers) {
        const result = await resolver.resolveSecret(input);
        if (result.resultType !== 'notFound') {
          return result;
        }
        missingResult = result;
      }
      return missingResult ?? { resultType: 'unavailable' };
    },
  };
}

export class FileRemoteFleetCredentialStore implements RemoteFleetCredentialStore {
  private readonly credentialsPath: string;
  private readonly keyPath: string;
  private keyPromise: Promise<Buffer> | null = null;

  constructor(input: {
    readonly runtimeDataRootDir: string;
  }) {
    const remoteFleetDir = path.join(input.runtimeDataRootDir, 'remote-fleet');
    this.credentialsPath = path.join(remoteFleetDir, 'credentials.json');
    this.keyPath = path.join(remoteFleetDir, 'credential-key');
  }

  async writeCredential(input: RemoteFleetCredentialWriteInput): Promise<RemoteFleetCredentialWriteResult> {
    validateCredentialWriteInput(input);
    return await this.runSerially(async () => {
      const credentialRef = buildRemoteFleetCredentialSecretRef(input.credentialId, input.credentialName);
      const state = await this.readState();
      const existingReceipt = state.writeReceipts[input.operationId];
      if (existingReceipt) {
        return isMatchingWriteReceipt(existingReceipt, input, credentialRef)
          ? completedWriteResult(existingReceipt)
          : { resultType: 'operationConflict' };
      }

      const existing = state.credentials[credentialRef.ref];
      const encrypted = await this.encryptSecret(credentialRef.ref, input.plaintextValue);
      const record: RemoteFleetCredentialRecord = {
        version: 1,
        credentialName: input.credentialName,
        secretRef: credentialRef.ref,
        ...encrypted,
        createdAt: existing?.createdAt ?? input.nowIso,
        updatedAt: input.nowIso,
      };
      const receipt: RemoteFleetCredentialWriteReceiptRecord = {
        version: 1,
        operationId: input.operationId,
        credentialName: input.credentialName,
        credentialRef: credentialRef.ref,
        writtenAt: input.nowIso,
      };
      await this.writeState({
        version: 1,
        credentials: {
          ...state.credentials,
          [credentialRef.ref]: record,
        },
        writeReceipts: {
          ...state.writeReceipts,
          [receipt.operationId]: receipt,
        },
      });
      return completedWriteResult(receipt);
    });
  }

  async lookupWriteReceipt(input: RemoteFleetCredentialWriteReceiptLookupInput): Promise<RemoteFleetCredentialWriteReceiptLookupResult> {
    return await this.runSerially(async () => {
      const receipt = (await this.readState()).writeReceipts[input.operationId];
      if (!receipt) {
        return { resultType: 'notFound' };
      }
      return receipt.credentialName === input.credentialName && receipt.credentialRef === input.credentialRef.ref
        ? { resultType: 'completed', credentialName: receipt.credentialName, credentialRef: input.credentialRef, writtenAt: receipt.writtenAt }
        : { resultType: 'operationConflict' };
    });
  }

  async resolveSecret(input: RemoteFleetSecretResolveRequestInput): Promise<RemoteFleetCredentialResolveResult> {
    const policy = evaluateRemoteFleetSecretRefPolicy(input.secretRef);
    if (policy.decision !== 'allowed') {
      return { resultType: 'accessDenied', secretRef: input.secretRef };
    }

    const state = await this.readState();
    const record = state.credentials[input.secretRef];
    if (!record) {
      return { resultType: 'notFound', secretRef: input.secretRef };
    }

    try {
      return {
        resultType: 'resolved',
        secretRef: input.secretRef,
        plaintextSecretValue: await this.decryptSecret(record),
      };
    } catch {
      return { resultType: 'unavailable' };
    }
  }

  private async runSerially<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const previous = credentialWriteQueues.get(this.credentialsPath) ?? Promise.resolve();
    let release: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    credentialWriteQueues.set(this.credentialsPath, current);
    await previous;
    try {
      return await operation();
    } finally {
      release!();
      if (credentialWriteQueues.get(this.credentialsPath) === current) {
        credentialWriteQueues.delete(this.credentialsPath);
      }
    }
  }

  private async encryptSecret(secretRef: string, plaintextValue: string): Promise<Pick<RemoteFleetCredentialRecord, 'iv' | 'ciphertext' | 'authTag'>> {
    const key = await this.readOrCreateKey();
    const iv = randomBytes(REMOTE_FLEET_CREDENTIAL_IV_BYTES);
    const cipher = createCipheriv(REMOTE_FLEET_CREDENTIAL_CIPHER, key, iv);
    cipher.setAAD(Buffer.from(secretRef, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintextValue, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    };
  }

  private async decryptSecret(record: RemoteFleetCredentialRecord): Promise<string> {
    const key = await this.readOrCreateKey();
    const decipher = createDecipheriv(
      REMOTE_FLEET_CREDENTIAL_CIPHER,
      key,
      Buffer.from(record.iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(record.secretRef, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private async readOrCreateKey(): Promise<Buffer> {
    this.keyPromise ??= this.loadOrCreateKey();
    return await this.keyPromise;
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    try {
      const key = Buffer.from((await readFile(this.keyPath, 'utf8')).trim(), 'base64url');
      if (key.length === REMOTE_FLEET_CREDENTIAL_KEY_BYTES) {
        return key;
      }
      throw new Error('Remote Fleet credential key is invalid.');
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const key = randomBytes(REMOTE_FLEET_CREDENTIAL_KEY_BYTES);
    await mkdir(path.dirname(this.keyPath), { recursive: true });
    await writeFile(this.keyPath, `${key.toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(this.keyPath, 0o600).catch(() => undefined);
    return key;
  }

  private async readState(): Promise<RemoteFleetCredentialPersistedState> {
    try {
      const parsed = JSON.parse(await readFile(this.credentialsPath, 'utf8')) as unknown;
      return deserializeRemoteFleetCredentialState(parsed);
    } catch (error) {
      if (isNotFoundError(error)) {
        return emptyCredentialState();
      }
      throw error;
    }
  }

  private async writeState(state: RemoteFleetCredentialPersistedState): Promise<void> {
    await mkdir(path.dirname(this.credentialsPath), { recursive: true });
    const temporaryPath = `${this.credentialsPath}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, this.credentialsPath);
  }
}

function validateCredentialWriteInput(input: RemoteFleetCredentialWriteInput): void {
  if (!isValidRemoteFleetCredentialPathSegment(input.operationId)) {
    throw new Error('Remote Fleet credential write operation id is not valid.');
  }
  validateCredentialPlaintext(input.plaintextValue);
}

function validateCredentialPlaintext(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Remote Fleet credential value is required.');
  }
  if (value.length > REMOTE_FLEET_CREDENTIAL_TEXT_LIMIT) {
    throw new Error('Remote Fleet credential value is too large.');
  }
}

function deserializeRemoteFleetCredentialState(value: unknown): RemoteFleetCredentialPersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote Fleet credential store is invalid.');
  }
  const record = value as Partial<RemoteFleetCredentialPersistedState>;
  if (record.version !== 1 || !isRecord(record.credentials)) {
    throw new Error('Remote Fleet credential store is invalid.');
  }
  const rawWriteReceipts = record.writeReceipts ?? {};
  if (!isRecord(rawWriteReceipts)) {
    throw new Error('Remote Fleet credential store is invalid.');
  }
  const credentials = Object.fromEntries(Object.entries(record.credentials).map(([secretRef, credential]) => {
    if (!isCredentialRecord(credential)) {
      throw new Error('Remote Fleet credential store contains an invalid credential.');
    }
    return [secretRef, credential];
  }));
  const writeReceipts = Object.fromEntries(Object.entries(rawWriteReceipts).map(([operationId, receipt]) => {
    if (!isCredentialWriteReceiptRecord(receipt) || receipt.operationId !== operationId) {
      throw new Error('Remote Fleet credential store contains an invalid write receipt.');
    }
    return [operationId, receipt];
  }));
  return { version: 1, credentials, writeReceipts };
}

function emptyCredentialState(): RemoteFleetCredentialPersistedState {
  return { version: 1, credentials: {}, writeReceipts: {} };
}

function isCredentialRecord(value: unknown): value is RemoteFleetCredentialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<RemoteFleetCredentialRecord>;
  return record.version === 1
    && isRemoteFleetWritableCredentialName(String(record.credentialName ?? ''))
    && typeof record.secretRef === 'string'
    && typeof record.iv === 'string'
    && typeof record.ciphertext === 'string'
    && typeof record.authTag === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string';
}

function isCredentialWriteReceiptRecord(value: unknown): value is RemoteFleetCredentialWriteReceiptRecord {
  if (!isRecord(value)) {
    return false;
  }
  return value.version === 1
    && typeof value.operationId === 'string'
    && isValidRemoteFleetCredentialPathSegment(value.operationId)
    && isRemoteFleetWritableCredentialName(String(value.credentialName ?? ''))
    && typeof value.credentialRef === 'string'
    && typeof value.writtenAt === 'string'
    && !Number.isNaN(Date.parse(value.writtenAt));
}

function isMatchingWriteReceipt(
  receipt: RemoteFleetCredentialWriteReceiptRecord,
  input: RemoteFleetCredentialWriteInput,
  credentialRef: RemoteFleetSecretRef,
): boolean {
  return receipt.credentialName === input.credentialName && receipt.credentialRef === credentialRef.ref;
}

function completedWriteResult(receipt: RemoteFleetCredentialWriteReceiptRecord): Extract<RemoteFleetCredentialWriteResult, { readonly resultType: 'written' }> {
  return {
    resultType: 'written',
    credentialName: receipt.credentialName,
    credentialRef: { kind: 'secret-ref', ref: receipt.credentialRef },
    writtenAt: receipt.writtenAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
