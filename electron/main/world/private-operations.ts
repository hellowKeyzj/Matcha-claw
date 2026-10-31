import type { IpcMainInvokeEvent } from 'electron';
import type { StorageOpenResult } from '../../../src/types/world-storage';
import type { WorldAccessImportResult, WorldAccessPrepareResult } from '../../../src/types/world-access';
import type { WorldEvaluationCommitResult, WorldEvaluationPrepareResult } from '../../../src/types/world-evaluation';
import { createWorldEvaluationImport, worldEvaluationIssue } from './evaluation-import';
import { createWorldAccessImport, worldAccessIssue } from './access-import';
import { configureWorldConnection } from './connections';
import { openWorldStorage, type WorldStorageOpenDependencies } from './storage-open';
import { initialWorldIssue } from './initial-errors';
import { worldPrivateAdmission } from './private-admission';
import { drainWorldSourceCredentials } from './source-credentials';
import {
  configureWorldStorage, drainWorldStorageConfiguration, worldStorageConfigurationStatus,
  type WorldStorageConfigurationResult,
} from './storage-config';
import { drainWorldStorageTransfers, transferWorldStorage, type WorldStorageControl } from './storage-transfer';
import type { WorldTransport } from './transport';

export type WorldPrivateActions = Omit<ReturnType<typeof createWorldPrivateOperations>, 'drain'>;

export function createWorldPrivateOperations(
  runtime: Promise<WorldTransport>, signal: AbortSignal, control: Promise<WorldStorageControl>,
  initial: WorldStorageOpenDependencies,
) {
  const pending = new Set<Promise<unknown>>();
  const evaluation = createWorldEvaluationImport(control, signal, initial);
  const access = createWorldAccessImport(control, signal, initial);
  let evaluationBusy = false;
  let accessBusy = false;
  let opening: Promise<StorageOpenResult> | undefined;
  const storageWrites = new Set<Promise<WorldStorageConfigurationResult>>();
  void control.catch(() => undefined);
  void runtime.catch(() => undefined);

  return {
    prepareEvaluation, commitEvaluation,
    evaluationStatus: (event: IpcMainInvokeEvent, args: readonly unknown[]) => track(evaluation.status(event, args)),
    prepareAccess, commitAccess, openStorage, configureStorage,
    transferStorage: (event: IpcMainInvokeEvent, input: unknown) => track(
      transferWorldStorage(input, control, signal, worldPrivateAdmission(event, signal, initial)),
    ),
    storageStatus: worldStorageConfigurationStatus,
    configureConnection: (event: IpcMainInvokeEvent, input: unknown) => track(
      configureWorldConnection(input, runtime, signal, worldPrivateAdmission(event, signal, initial)),
    ),
    drain,
  };

  function track<T>(operation: Promise<T>): Promise<T> {
    pending.add(operation);
    return operation.finally(() => { pending.delete(operation); });
  }

  function prepareEvaluation(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<WorldEvaluationPrepareResult> {
    if (signal.aborted || evaluationBusy) return Promise.resolve({ outcome: 'not-attempted',
      error: worldEvaluationIssue(evaluationBusy ? 'import-busy' : 'authorization-denied', 'admission') });
    evaluationBusy = true;
    const operation = evaluation.prepare(event, args);
    pending.add(operation);
    return operation.finally(() => { evaluationBusy = false; pending.delete(operation); });
  }
  function commitEvaluation(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<WorldEvaluationCommitResult> {
    if (signal.aborted || evaluationBusy) return Promise.resolve({ outcome: 'not-attempted',
      error: worldEvaluationIssue(evaluationBusy ? 'import-busy' : 'authorization-denied', 'admission') });
    evaluationBusy = true;
    const operation = evaluation.commit(event, args);
    pending.add(operation);
    return operation.finally(() => { evaluationBusy = false; pending.delete(operation); });
  }
  function prepareAccess(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<WorldAccessPrepareResult> {
    if (signal.aborted || accessBusy) return Promise.resolve({ outcome: 'not-attempted',
      error: worldAccessIssue(accessBusy ? 'import-busy' : 'authorization-denied', 'admission') });
    accessBusy = true;
    const operation = access.prepare(event, args);
    pending.add(operation);
    return operation.finally(() => { accessBusy = false; pending.delete(operation); });
  }
  function commitAccess(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<WorldAccessImportResult> {
    if (signal.aborted || accessBusy) return Promise.resolve({ outcome: 'not-attempted',
      error: worldAccessIssue(accessBusy ? 'import-busy' : 'authorization-denied', 'admission') });
    accessBusy = true;
    const operation = access.commit(event, args);
    pending.add(operation);
    return operation.finally(() => { accessBusy = false; pending.delete(operation); });
  }
  function openStorage(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<StorageOpenResult> {
    if (signal.aborted || opening || storageWrites.size > 0) return Promise.resolve({ outcome: 'not-attempted',
      error: initialWorldIssue(opening || storageWrites.size > 0 ? 'import-busy' : 'authorization-denied', 'admission') });
    const operation = openWorldStorage(event, args, control, signal, initial);
    opening = operation;
    pending.add(operation);
    return operation.finally(() => { opening = undefined; pending.delete(operation); });
  }
  function configureStorage(event: IpcMainInvokeEvent, input: unknown): Promise<WorldStorageConfigurationResult> {
    if (opening) return Promise.resolve({ outcome: 'not-saved', reason: 'invalid-request' });
    const operation = configureWorldStorage(input, worldPrivateAdmission(event, signal, initial));
    storageWrites.add(operation);
    return operation.finally(() => { storageWrites.delete(operation); });
  }
  async function drain(): Promise<void> {
    access.close();
    evaluation.close();
    await Promise.allSettled([...pending, ...storageWrites]);
    await drainWorldSourceCredentials();
    await drainWorldStorageConfiguration();
    await drainWorldStorageTransfers();
  }
}
