import { ipcMain } from 'electron';
import {
  drainWorldStorageTransfers, transferWorldStorage, type WorldStorageControl,
  type WorldStorageTransferResult,
} from './storage-transfer';
import {
  configureWorldStorage, drainWorldStorageConfiguration, worldStorageConfigurationStatus,
  type WorldStorageConfigurationResult,
} from './storage-config';
import type { StorageOpenResult } from '../../../src/types/world-storage';
import type { WorldAccessImportResult, WorldAccessPrepareResult } from '../../../src/types/world-access';
import type { WorldEvaluationCommitResult, WorldEvaluationPrepareResult, WorldEvaluationStatusResult } from '../../../src/types/world-evaluation';
import { createWorldEvaluationImport, worldEvaluationIssue } from './evaluation-import';
import { createWorldAccessImport, worldAccessIssue } from './access-import';
import { openWorldStorage, type WorldStorageOpenDependencies } from './storage-open';
import { initialWorldIssue } from './initial-errors';
import { worldPrivateAdmission, WorldPrivateAdmissionError } from './private-admission';
import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { configuredConnection, type WorldDelivery, type WorldTransport } from './transport';
import {
  drainWorldSourceCredentials, parseWorldSourceCredential, requireWorldSourceCredential,
  storeWorldSourceCredential, WorldSourceCredentialError,
} from './source-credentials';

export function registerWorldPrivateHandlers(
  runtime: Promise<WorldTransport>, signal: AbortSignal, control: Promise<WorldStorageControl>,
  initial: WorldStorageOpenDependencies,
): () => Promise<void> {
  const pending = new Set<Promise<WorldDelivery | WorldStorageTransferResult | StorageOpenResult | WorldAccessPrepareResult | WorldAccessImportResult
    | WorldEvaluationPrepareResult | WorldEvaluationCommitResult | WorldEvaluationStatusResult>>();
  const evaluation = createWorldEvaluationImport(control, signal, initial);
  let evaluationBusy = false;
  ipcMain.handle('world:prepareEvaluation', (event, ...args: unknown[]): Promise<WorldEvaluationPrepareResult> => {
    if (signal.aborted || evaluationBusy) return Promise.resolve({ outcome: 'not-attempted',
      error: worldEvaluationIssue(evaluationBusy ? 'import-busy' : 'authorization-denied', 'admission') });
    evaluationBusy = true;
    const operation = evaluation.prepare(event, args);
    pending.add(operation);
    return operation.finally(() => { evaluationBusy = false; pending.delete(operation); });
  });
  ipcMain.handle('world:commitEvaluation', (event, ...args: unknown[]): Promise<WorldEvaluationCommitResult> => {
    if (signal.aborted || evaluationBusy) return Promise.resolve({ outcome: 'not-attempted',
      error: worldEvaluationIssue(evaluationBusy ? 'import-busy' : 'authorization-denied', 'admission') });
    evaluationBusy = true;
    const operation = evaluation.commit(event, args);
    pending.add(operation);
    return operation.finally(() => { evaluationBusy = false; pending.delete(operation); });
  });
  ipcMain.handle('world:evaluationStatus', (event, ...args: unknown[]): Promise<WorldEvaluationStatusResult> => {
    const operation = evaluation.status(event, args);
    pending.add(operation);
    return operation.finally(() => { pending.delete(operation); });
  });
  let opening: Promise<StorageOpenResult> | undefined;
  const storageWrites = new Set<Promise<WorldStorageConfigurationResult>>();
  const access = createWorldAccessImport(control, signal, initial);
  let accessBusy = false;
  ipcMain.handle('world:prepareAccess', (event, ...args: unknown[]): Promise<WorldAccessPrepareResult> => {
    if (signal.aborted || accessBusy) return Promise.resolve({ outcome: 'not-attempted',
      error: worldAccessIssue(accessBusy ? 'import-busy' : 'authorization-denied', 'admission') });
    accessBusy = true;
    const operation = access.prepare(event, args);
    pending.add(operation);
    return operation.finally(() => { accessBusy = false; pending.delete(operation); });
  });
  ipcMain.handle('world:commitAccess', (event, ...args: unknown[]): Promise<WorldAccessImportResult> => {
    if (signal.aborted || accessBusy) return Promise.resolve({ outcome: 'not-attempted',
      error: worldAccessIssue(accessBusy ? 'import-busy' : 'authorization-denied', 'admission') });
    accessBusy = true;
    const operation = access.commit(event, args);
    pending.add(operation);
    return operation.finally(() => { accessBusy = false; pending.delete(operation); });
  });
  ipcMain.handle('world:openStorage', (event, ...args: unknown[]): Promise<StorageOpenResult> => {
    if (signal.aborted || opening || storageWrites.size > 0) return Promise.resolve({ outcome: 'not-attempted',
      error: initialWorldIssue(opening || storageWrites.size > 0 ? 'import-busy' : 'authorization-denied', 'admission') });
    const operation = openWorldStorage(event, args, control, signal, initial);
    opening = operation;
    pending.add(operation);
    return operation.finally(() => { opening = undefined; pending.delete(operation); });
  });
  void control.catch(() => undefined);
  ipcMain.handle('world:transferStorage', (event, input: unknown): Promise<WorldStorageTransferResult> => {
    const operation = transferWorldStorage(input, control, signal, worldPrivateAdmission(event, signal, initial));
    pending.add(operation);
    return operation.finally(() => { pending.delete(operation); });
  });
  ipcMain.handle('world:storageStatus', () => worldStorageConfigurationStatus());
  ipcMain.handle('world:configureStorage', (event, input: unknown): Promise<WorldStorageConfigurationResult> => {
    if (opening) return Promise.resolve({ outcome: 'not-saved', reason: 'invalid-request' });
    const operation = configureWorldStorage(input, worldPrivateAdmission(event, signal, initial));
    storageWrites.add(operation);
    return operation.finally(() => { storageWrites.delete(operation); });
  });
  void runtime.catch(() => undefined);
  ipcMain.handle('world:configureConnection', (event, input: unknown): Promise<WorldDelivery> => {
    const operation = configure(input, worldPrivateAdmission(event, signal, initial));
    pending.add(operation);
    return operation.finally(() => { pending.delete(operation); });
  });
  async function configure(input: unknown, admit: () => Promise<void>): Promise<WorldDelivery> {
    let dispatching = false;
    try {
      await admit();
      if (!isRecord(input) || !(hasExactKeys(input, ['request', 'credential']) || hasExactKeys(input, ['request']))) {
        return { outcome: 'not-attempted', reason: 'invalid-request' };
      }
      const body: unknown = JSON.parse(JSON.stringify(input.request));
      const configured = configuredConnection(body);
      if (!configured) return { outcome: 'not-attempted', reason: 'invalid-request' };
      const transport = await runtime;
      await admit();
      const kind = (configured.connection.config as { kind: string }).kind;
      if (kind === 'plugin') {
        if (Object.hasOwn(input, 'credential')) return { outcome: 'not-attempted', reason: 'invalid-request' };
      } else if (Object.hasOwn(input, 'credential')) {
        const credential = parseWorldSourceCredential(input.credential);
        if ((kind === 'postgres' && credential.kind !== 'postgres')
          || (kind === 'http_json' && credential.kind !== 'none' && credential.kind !== 'http_bearer')) {
          return { outcome: 'not-attempted', reason: 'invalid-request' };
        }
        await storeWorldSourceCredential(configured.identity, configured.connection, credential, admit);
      } else {
        await requireWorldSourceCredential(configured.identity, configured.connection);
      }
      // Persist first, then deliver only the public command. A lost observer or even a
      // failure response does not prove rollback; keep the immutable credential binding.
      dispatching = true;
      return await transport.request('command', body, signal, undefined, admit);
    } catch (error) {
      if (dispatching) return { outcome: 'unknown' };
      if (error instanceof WorldPrivateAdmissionError) return { outcome: 'not-attempted', reason: error.reason };
      return { outcome: 'not-attempted', reason: error instanceof WorldSourceCredentialError
        ? error.code === 'credential-missing' || error.code === 'credential-revision-conflict' ? error.code : 'credential-unavailable'
        : 'invalid-request' };
    }
  }
  return async () => {
    access.close();
    evaluation.close();
    await Promise.allSettled([...pending, ...storageWrites]);
    await drainWorldSourceCredentials();
    await drainWorldStorageConfiguration();
    await drainWorldStorageTransfers();
  };
}
