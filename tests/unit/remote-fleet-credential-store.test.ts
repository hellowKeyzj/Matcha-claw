import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRemoteFleetCredentialSecretRef,
  FileRemoteFleetCredentialStore,
  type RemoteFleetCredentialWriteInput,
} from '../../runtime-host/application/remote-fleet/remote-fleet-credential-store';
import { REMOTE_FLEET_SECRET_RESOLVE_PURPOSE } from '../../runtime-host/application/remote-fleet/remote-fleet-secret-host-rpc';

const initialWriteTime = '2026-07-11T10:00:00.000Z';
const retryWriteTime = '2026-07-11T10:01:00.000Z';

function credentialWriteInput(
  overrides: Partial<RemoteFleetCredentialWriteInput> = {},
): RemoteFleetCredentialWriteInput {
  return {
    operationId: 'credential-write-1',
    credentialId: 'node-1',
    credentialName: 'sshPassword',
    plaintextValue: 'test-plaintext-secret',
    nowIso: initialWriteTime,
    ...overrides,
  };
}

describe('FileRemoteFleetCredentialStore', () => {
  let runtimeDataRootDir = '';

  const credentialsPath = () => join(runtimeDataRootDir, 'remote-fleet', 'credentials.json');
  const keyPath = () => join(runtimeDataRootDir, 'remote-fleet', 'credential-key');
  const createStore = () => new FileRemoteFleetCredentialStore({ runtimeDataRootDir });

  beforeEach(async () => {
    runtimeDataRootDir = await mkdtemp(join(tmpdir(), 'matchaclaw-remote-fleet-credentials-'));
  });

  afterEach(async () => {
    await rm(runtimeDataRootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns the original receipt for a same-target operation retry without changing the credential record', async () => {
    const store = createStore();
    const firstInput = credentialWriteInput();

    const initialResult = await store.writeCredential(firstInput);
    const persistedBeforeRetry = JSON.parse(await readFile(credentialsPath(), 'utf8'));
    const retryResult = await store.writeCredential({
      ...firstInput,
      plaintextValue: 'different-retry-plaintext',
      nowIso: retryWriteTime,
    });
    const persistedAfterRetry = JSON.parse(await readFile(credentialsPath(), 'utf8'));

    expect(initialResult).toEqual({
      resultType: 'written',
      credentialName: 'sshPassword',
      credentialRef: buildRemoteFleetCredentialSecretRef('node-1', 'sshPassword'),
      writtenAt: initialWriteTime,
    });
    expect(retryResult).toEqual(initialResult);
    expect(persistedAfterRetry.credentials).toEqual(persistedBeforeRetry.credentials);
    expect(persistedAfterRetry).toEqual(persistedBeforeRetry);
  });

  it('returns operationConflict when an operation id is retried for a different credential target', async () => {
    const store = createStore();

    await store.writeCredential(credentialWriteInput());
    const result = await store.writeCredential(credentialWriteInput({
      credentialId: 'node-2',
      plaintextValue: 'node-2-plaintext',
      nowIso: retryWriteTime,
    }));
    const persistedState = JSON.parse(await readFile(credentialsPath(), 'utf8'));

    expect(result).toEqual({ resultType: 'operationConflict' });
    expect(Object.keys(persistedState.credentials)).toEqual([
      buildRemoteFleetCredentialSecretRef('node-1', 'sshPassword').ref,
    ]);
    expect(Object.keys(persistedState.writeReceipts)).toEqual(['credential-write-1']);
  });

  it('looks up completed, missing, and conflicting write receipts', async () => {
    const store = createStore();
    const credentialRef = buildRemoteFleetCredentialSecretRef('node-1', 'sshPassword');

    await store.writeCredential(credentialWriteInput());

    await expect(store.lookupWriteReceipt({
      operationId: 'credential-write-1',
      credentialName: 'sshPassword',
      credentialRef,
    })).resolves.toEqual({
      resultType: 'completed',
      credentialName: 'sshPassword',
      credentialRef,
      writtenAt: initialWriteTime,
    });
    await expect(store.lookupWriteReceipt({
      operationId: 'missing-operation',
      credentialName: 'sshPassword',
      credentialRef,
    })).resolves.toEqual({ resultType: 'notFound' });
    await expect(store.lookupWriteReceipt({
      operationId: 'credential-write-1',
      credentialName: 'sshPassword',
      credentialRef: buildRemoteFleetCredentialSecretRef('node-2', 'sshPassword'),
    })).resolves.toEqual({ resultType: 'operationConflict' });
  });

  it('reads legacy v1 credential state without writeReceipts and appends receipts for new writes', async () => {
    const originalStore = createStore();
    const legacyCredentialInput = credentialWriteInput({
      operationId: 'legacy-bootstrap',
      credentialId: 'legacy-node',
      plaintextValue: 'legacy-plaintext-secret',
    });
    const legacyCredentialRef = buildRemoteFleetCredentialSecretRef('legacy-node', 'sshPassword');

    await originalStore.writeCredential(legacyCredentialInput);
    const currentState = JSON.parse(await readFile(credentialsPath(), 'utf8'));
    await writeFile(credentialsPath(), `${JSON.stringify({
      version: 1,
      credentials: currentState.credentials,
    }, null, 2)}\n`, 'utf8');

    const restartedStore = createStore();
    await expect(restartedStore.resolveSecret({
      secretRef: legacyCredentialRef.ref,
      purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
      commandExecutionId: 'legacy-read',
    })).resolves.toEqual({
      resultType: 'resolved',
      secretRef: legacyCredentialRef.ref,
      plaintextSecretValue: 'legacy-plaintext-secret',
    });
    await expect(restartedStore.writeCredential(credentialWriteInput({
      operationId: 'post-legacy-write',
      credentialId: 'new-node',
      plaintextValue: 'new-plaintext-secret',
      nowIso: retryWriteTime,
    }))).resolves.toEqual({
      resultType: 'written',
      credentialName: 'sshPassword',
      credentialRef: buildRemoteFleetCredentialSecretRef('new-node', 'sshPassword'),
      writtenAt: retryWriteTime,
    });
  });

  it('preserves both records when two instances write distinct credentials concurrently', async () => {
    const firstStore = createStore();
    const secondStore = createStore();
    const firstInput = credentialWriteInput({
      operationId: 'concurrent-write-1',
      credentialId: 'concurrent-node-1',
      plaintextValue: 'concurrent-plaintext-1',
    });
    const secondInput = credentialWriteInput({
      operationId: 'concurrent-write-2',
      credentialId: 'concurrent-node-2',
      plaintextValue: 'concurrent-plaintext-2',
      nowIso: retryWriteTime,
    });
    const firstCredentialRef = buildRemoteFleetCredentialSecretRef('concurrent-node-1', 'sshPassword');
    const secondCredentialRef = buildRemoteFleetCredentialSecretRef('concurrent-node-2', 'sshPassword');

    await expect(Promise.all([
      firstStore.writeCredential(firstInput),
      secondStore.writeCredential(secondInput),
    ])).resolves.toEqual([
      {
        resultType: 'written',
        credentialName: 'sshPassword',
        credentialRef: firstCredentialRef,
        writtenAt: initialWriteTime,
      },
      {
        resultType: 'written',
        credentialName: 'sshPassword',
        credentialRef: secondCredentialRef,
        writtenAt: retryWriteTime,
      },
    ]);

    const persistedState = JSON.parse(await readFile(credentialsPath(), 'utf8'));
    expect(Object.keys(persistedState.credentials).sort()).toEqual([
      firstCredentialRef.ref,
      secondCredentialRef.ref,
    ].sort());
    expect(Object.keys(persistedState.writeReceipts).sort()).toEqual([
      firstInput.operationId,
      secondInput.operationId,
    ].sort());
    await expect(createStore().resolveSecret({
      secretRef: firstCredentialRef.ref,
      purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
      commandExecutionId: 'concurrent-read-1',
    })).resolves.toMatchObject({
      resultType: 'resolved',
      plaintextSecretValue: 'concurrent-plaintext-1',
    });
    await expect(createStore().resolveSecret({
      secretRef: secondCredentialRef.ref,
      purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
      commandExecutionId: 'concurrent-read-2',
    })).resolves.toMatchObject({
      resultType: 'resolved',
      plaintextSecretValue: 'concurrent-plaintext-2',
    });
  });

  it('never persists plaintext and keeps write receipts free of cryptographic material', async () => {
    const plaintextValue = 'never-persist-this-plaintext';
    const store = createStore();

    await store.writeCredential(credentialWriteInput({ plaintextValue }));

    const rawState = await readFile(credentialsPath(), 'utf8');
    const persistedState = JSON.parse(rawState);
    const receipt = persistedState.writeReceipts['credential-write-1'];

    expect(rawState).not.toContain(plaintextValue);
    expect(receipt).toEqual({
      version: 1,
      operationId: 'credential-write-1',
      credentialName: 'sshPassword',
      credentialRef: buildRemoteFleetCredentialSecretRef('node-1', 'sshPassword').ref,
      writtenAt: initialWriteTime,
    });
    expect(receipt).not.toHaveProperty('iv');
    expect(receipt).not.toHaveProperty('ciphertext');
    expect(receipt).not.toHaveProperty('authTag');
  });

  it('fails closed when persisted credential state is corrupted', async () => {
    await mkdir(dirname(credentialsPath()), { recursive: true });
    await writeFile(credentialsPath(), '{"version":1,"credentials":', 'utf8');
    const store = createStore();
    const credentialRef = buildRemoteFleetCredentialSecretRef('node-1', 'sshPassword');

    await expect(store.lookupWriteReceipt({
      operationId: 'corrupted-state-operation',
      credentialName: 'sshPassword',
      credentialRef,
    })).rejects.toThrow();
    await expect(store.writeCredential(credentialWriteInput({
      operationId: 'corrupted-state-operation',
    }))).rejects.toThrow();
  });

  it('fails closed when the persisted credential key is malformed', async () => {
    await mkdir(dirname(keyPath()), { recursive: true });
    await writeFile(keyPath(), 'not-a-valid-credential-key\n', 'utf8');
    const store = createStore();

    await expect(store.writeCredential(credentialWriteInput({
      operationId: 'malformed-key-operation',
    }))).rejects.toThrow('Remote Fleet credential key is invalid.');
    await expect(readFile(credentialsPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
