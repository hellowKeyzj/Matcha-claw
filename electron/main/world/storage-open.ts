import { isDeepStrictEqual } from 'node:util';
import type { IpcMainInvokeEvent } from 'electron';
import type { WorldRef } from '../../../src/types/world';
import type { InitialWorldIssue } from '../../../src/types/world-initial';
import type { StorageOpenResult } from '../../../src/types/world-storage';
import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { isWorldRef } from './events';
import {
  clearInitialWorldBootstrap, InitialWorldConfigurationError, readInitialWorldBootstrap, saveInitialWorldBootstrap,
} from './initial-config';
import { InitialWorldImportError, initialControlData, initialWorldIssue } from './initial-errors';
import {
  isWorldStorageConnectionString, readWorldStorageBootstrap, saveOpenedWorldStorage, type WorldPostgresConfiguration,
} from './storage-config';
import type { WorldStorageControl } from './storage-transfer';
import { worldPrivateAdmission, WorldPrivateAdmissionError, type WorldPrivateAdmissionDependencies } from './private-admission';

export type WorldStorageOpenDependencies = WorldPrivateAdmissionDependencies & Readonly<{
  validateStorageBootstrap: (storage: WorldPostgresConfiguration, configuration?: Readonly<Record<string, unknown>>) => Promise<void>;
}>;
type OriginalIdentity = Readonly<{ world: WorldRef; commitId: string }>;
type Connected =
  | Readonly<{ kind: 'existing'; storageId: string; worlds: WorldRef[] }>
  | Readonly<{ kind: 'fresh'; storageId: string; configuration: Readonly<Record<string, unknown>>; safeSummary: OriginalIdentity }>;

/** Main keeps connection secrets and the original request; Rust alone discovers and initializes Worlds. */
export async function openWorldStorage(
  event: IpcMainInvokeEvent, args: readonly unknown[], control: Promise<WorldStorageControl>,
  signal: AbortSignal, deps: WorldStorageOpenDependencies,
): Promise<StorageOpenResult> {
  let identity: OriginalIdentity | undefined;
  let custody = false;
  let issue = initialWorldIssue('connection-unavailable', 'read');
  const admit = worldPrivateAdmission(event, signal, deps);
  const unconfirmed = (error: InitialWorldIssue): StorageOpenResult => custody || error.reason === 'outcome-unknown'
    || error.reason === 'unknown-delivery' || error.reason === 'timed-out'
    ? { outcome: 'unknown', error, ...(identity ? { world: identity.world, commitId: identity.commitId } : {}) }
    : { outcome: 'not-attempted', error };
  if (args.length > 1 || (args.length === 1 && (!isRecord(args[0])
    || !hasExactKeys(args[0], ['connectionString']) || !isWorldStorageConnectionString(args[0].connectionString)))) {
    return unconfirmed(initialWorldIssue('invalid-request', 'decode'));
  }
  const requested = args.length === 1 ? (args[0] as { connectionString: string }).connectionString : undefined;
  try {
    await admit();
    let storage = (await readWorldStorageBootstrap()).worldPostgres;
    const original = await readInitialWorldBootstrap();
    if (original) {
      custody = true;
      if (isOriginal(original)) identity = { world: original.world, commitId: original.commitId };
    }
    if (!storage && !original && requested === undefined) return { outcome: 'not-configured' };
    const host = await control;
    await admit();
    const connect = async (connectionString: string): Promise<Connected> => {
      issue = initialWorldIssue('connection-unavailable', 'execute');
      await admit();
      const connected = await initialControlData(host, { name: 'world.storage.connect', input: { connectionString } }, 120_000);
      await admit();
      if (!isConnected(connected)) throw new InitialWorldImportError(initialWorldIssue('configuration-invalid', 'decode'));
      return connected;
    };
    const confirmOriginal = async (
      configuration: Readonly<Record<string, unknown>>, target: WorldPostgresConfiguration,
    ): Promise<Extract<Connected, { kind: 'existing' }>> => {
      issue = initialWorldIssue('configuration-conflict', 'validate');
      if (!isOriginal(configuration) || configuration.storageId !== target.storageId) throw new InitialWorldImportError(issue);
      const expected = { world: configuration.world, commitId: configuration.commitId };
      identity = expected;
      issue = initialWorldIssue('ready-unconfirmed', 'execute');
      await admit();
      // The owner checks the original CommitId and input digest before any bootstrap mutation.
      const provisioned = await initialControlData(host, {
        name: 'world.initial.provision', input: { storage: target, configuration },
      }, 120_000);
      if (!isRecord(provisioned) || !hasExactKeys(provisioned, ['head', 'commit'])
        || !isRecord(provisioned.head) || !isRecord(provisioned.commit)
        || provisioned.head.status !== 'ready' || !isDeepStrictEqual(provisioned.head.world, expected.world)
        || !isDeepStrictEqual(provisioned.commit.world, expected.world) || provisioned.commit.commitId !== expected.commitId) {
        throw new InitialWorldImportError(initialWorldIssue('ready-unconfirmed', 'verify'));
      }
      const connected = await connect(target.connectionString);
      if (connected.kind !== 'existing' || connected.storageId !== target.storageId
        || !connected.worlds.some((world) => isDeepStrictEqual(world, expected.world))) {
        throw new InitialWorldImportError(initialWorldIssue('ready-unconfirmed', 'verify'));
      }
      issue = initialWorldIssue('configuration-unavailable', 'commit');
      await admit();
      if (!await clearInitialWorldBootstrap(configuration)) {
        throw new InitialWorldImportError(initialWorldIssue('configuration-conflict', 'commit'));
      }
      custody = false;
      identity = undefined;
      return connected;
    };
    if (original) {
      if (!storage) return unconfirmed(initialWorldIssue('storage-not-configured', 'recover'));
      const recovered = await confirmOriginal(original, storage);
      if (requested === undefined || requested === storage.connectionString) {
        return { outcome: 'opened', storageId: recovered.storageId, worlds: recovered.worlds };
      }
    }
    const connectionString = requested ?? storage!.connectionString;
    const connected = await connect(connectionString);
    const target = { storageId: connected.storageId, connectionString };
    const configuration = connected.kind === 'fresh' ? connected.configuration : undefined;
    issue = initialWorldIssue('bootstrap-invalid', 'prepare');
    await deps.validateStorageBootstrap(target, configuration);
    issue = initialWorldIssue('connection-unavailable', 'commit');
    if (await saveOpenedWorldStorage(target, storage, admit) === 'conflict') {
      return unconfirmed(initialWorldIssue('configuration-conflict', 'commit'));
    }
    storage = target;
    if (connected.kind === 'existing') {
      await admit();
      return { outcome: 'opened', storageId: connected.storageId, worlds: connected.worlds };
    }
    identity = connected.safeSummary;
    issue = initialWorldIssue('configuration-unavailable', 'commit');
    if (await saveInitialWorldBootstrap(connected.configuration, async () => {
      await admit();
      // A failed publish observer does not prove the original request was not retained.
      custody = true;
    }) === 'conflict') {
      identity = undefined;
      return unconfirmed(initialWorldIssue('configuration-conflict', 'commit'));
    }
    const opened = await confirmOriginal(connected.configuration, storage);
    return { outcome: 'opened', storageId: opened.storageId, worlds: opened.worlds };
  } catch (error) {
    if (error instanceof WorldPrivateAdmissionError) issue = initialWorldIssue(error.reason, 'admission');
    else if (error instanceof InitialWorldImportError) issue = error.issue;
    else if (error instanceof InitialWorldConfigurationError) {
      custody = true;
      issue = initialWorldIssue(error.reason === 'invalid' ? 'configuration-invalid' : 'configuration-unavailable', 'read');
    }
    return unconfirmed(issue);
  }
}

function isOriginal(value: Readonly<Record<string, unknown>>): value is Readonly<Record<string, unknown>> & OriginalIdentity {
  return identifier(value.storageId) && isWorldRef(value.world) && identifier(value.commitId);
}
function isConnected(value: unknown): value is Connected {
  if (!isRecord(value) || !identifier(value.storageId)) return false;
  if (value.kind === 'existing') return hasExactKeys(value, ['kind', 'storageId', 'worlds'])
    && Array.isArray(value.worlds) && value.worlds.every(isWorldRef);
  if (value.kind !== 'fresh' || !hasExactKeys(value, ['kind', 'storageId', 'configuration', 'safeSummary'])
    || !isRecord(value.configuration) || !isOriginal(value.configuration) || !isSummary(value.safeSummary)) return false;
  return value.configuration.storageId === value.storageId
    && isDeepStrictEqual(value.configuration.world, value.safeSummary.world)
    && value.configuration.commitId === value.safeSummary.commitId;
}
function isSummary(value: unknown): value is OriginalIdentity {
  return isRecord(value) && hasExactKeys(value, ['world', 'commitId', 'principalCount', 'grantCount', 'policyCount', 'retentionPolicyCount', 'evaluation', 'maintenance'])
    && isWorldRef(value.world) && identifier(value.commitId)
    && ['principalCount', 'grantCount', 'policyCount', 'retentionPolicyCount'].every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
    && typeof value.evaluation === 'boolean' && typeof value.maintenance === 'boolean';
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}
