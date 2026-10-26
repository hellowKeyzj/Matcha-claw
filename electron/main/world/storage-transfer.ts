import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { Failure, WorldRef } from '../../../src/types/world';
import {
  isWorldStorageTransferCut, type RuntimeHostControlCommand, type RuntimeHostControlOutcome,
  type WorldStorageTransferCut,
} from '../runtime-host-delivery/control';
import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { isWorldRef } from './events';
import { worldStorageConfigurationStatus } from './storage-config';
import { WorldPrivateAdmissionError } from './private-admission';

const MAX_JOURNAL_BYTES = 1024 * 1024;
const JOURNAL_FILE = 'world-storage-transfers.v1.json';
type Action = 'resume' | 'abort';
type Phase = 'unknown' | 'prepared' | 'activated' | 'aborted' | 'failed';
export type WorldStorageTransferStatus = Readonly<{
  transferId: string; world: WorldRef; targetStorageId: string; phase: Phase; action: Action; error?: Failure;
}>;
type Entry = { -readonly [K in keyof WorldStorageTransferStatus]: WorldStorageTransferStatus[K] } & { cut?: WorldStorageTransferCut };
export type WorldStorageTransferInput =
  | Readonly<{ action: 'prepare'; world: WorldRef; targetStorageId: string }>
  | Readonly<{ action: Action | 'status'; transferId: string }>
  | Readonly<{ action: 'status'; world: WorldRef }>;
export type WorldStorageTransferResult =
  | Readonly<{ outcome: 'status'; transfer: WorldStorageTransferStatus }>
  | Readonly<{ outcome: 'not-found' }>
  | Readonly<{ outcome: 'not-attempted'; reason: 'invalid-request' | 'transfer-conflict' | 'restart-required' | 'unauthorized' }>
  | Readonly<{ outcome: 'unknown'; reason: 'storage-unavailable'; transferId?: string }>;
export type WorldStorageControl = Readonly<{
  command(command: RuntimeHostControlCommand, options?: { timeoutMs?: number }): Promise<RuntimeHostControlOutcome>;
}>;
let writes: Promise<unknown> = Promise.resolve();

/** Private delivery journal only. Rust owns the locator, original cut and migration state. */
export function transferWorldStorage(
  input: unknown, runtime: Promise<WorldStorageControl>, signal: AbortSignal, admit: () => Promise<void>,
): Promise<WorldStorageTransferResult> {
  const operation = writes.then(() => transfer(input, runtime, signal, admit));
  writes = operation.catch(() => undefined);
  return operation;
}
export async function drainWorldStorageTransfers(): Promise<void> { await writes; }

async function transfer(
  input: unknown, runtime: Promise<WorldStorageControl>, signal: AbortSignal, admit: () => Promise<void>,
): Promise<WorldStorageTransferResult> {
  if (!validInput(input)) return { outcome: 'not-attempted', reason: 'invalid-request' };
  let entry: Entry | undefined;
  let dispatched = false;
  try {
    await admit();
    const journal = await readJournal();
    entry = 'transferId' in input ? journal.find((item) => item.transferId === input.transferId)
      : [...journal].reverse().find((item) => sameWorld(item.world, input.world));
    if (input.action === 'status') return entry ? status(entry) : { outcome: 'not-found' };
    if (signal.aborted) return entry ? status(entry) : { outcome: 'not-attempted', reason: 'invalid-request' };
    if (input.action === 'prepare') {
      if (entry && (entry.targetStorageId === input.targetStorageId || (entry.phase !== 'activated' && entry.phase !== 'aborted'))) {
        if (entry.targetStorageId !== input.targetStorageId) return { outcome: 'not-attempted', reason: 'transfer-conflict' };
      } else {
        const saved = await worldStorageConfigurationStatus();
        if (saved.outcome !== 'available') return { outcome: 'unknown', reason: 'storage-unavailable' };
        if (!saved.targetStorageIds.includes(input.targetStorageId)) return { outcome: 'not-attempted', reason: 'invalid-request' };
        if (!saved.registeredTargetStorageIds.includes(input.targetStorageId)) return { outcome: 'not-attempted', reason: 'restart-required' };
        entry = { transferId: randomUUID(), world: input.world, targetStorageId: input.targetStorageId, phase: 'unknown', action: 'resume' };
        journal.push(entry);
        // The first identity is durable before either control command can be sent.
        await admit();
        await saveJournal(journal, admit);
      }
    }
    if (!entry) return { outcome: 'not-found' };
    if (entry.phase === 'activated' || entry.phase === 'aborted') return status(entry);
    const host = await runtime;
    if (signal.aborted) return status(entry);
    if (input.action === 'resume' || input.action === 'abort') entry.action = input.action;
    if (!entry.cut) {
      await checkpoint(journal, entry, 'unknown', undefined, admit);
      await admit();
      dispatched = true;
      const prepared = await host.command({ name: 'world.storage.transfer.prepare', input: {
        world: entry.world, targetStorageId: entry.targetStorageId, transferId: entry.transferId,
      } }, { timeoutMs: 120_000 });
      const result = domainResult(prepared);
      if (result.kind !== 'success') {
        await checkpoint(journal, entry, result.kind === 'failure' ? 'failed' : 'unknown', result.error);
        return status(entry);
      }
      if (!isRecord(result.data) || !hasExactKeys(result.data, ['action', 'cut'])
        || result.data.action !== 'resume' || !isWorldStorageTransferCut(result.data.cut)
        || result.data.cut.transferId !== entry.transferId || !sameWorld(result.data.cut.world, entry.world)
        || result.data.cut.targetStorageId !== entry.targetStorageId) return status(entry);
      // Preserve the producer's exact cut; never calculate epochs or a replacement cut.
      entry.cut = result.data.cut;
      await checkpoint(journal, entry, 'prepared');
    }
    if (input.action === 'prepare' || signal.aborted) return status(entry);
    await checkpoint(journal, entry, 'unknown', undefined, admit);
    await admit();
    dispatched = true;
    const executed = await host.command({ name: 'world.storage.transfer', input: { action: entry.action, cut: entry.cut } }, { timeoutMs: 120_000 });
    const result = domainResult(executed);
    if (result.kind !== 'success') {
      await checkpoint(journal, entry, result.kind === 'failure' ? 'failed' : 'unknown', result.error);
      return status(entry);
    }
    if (!isRecord(result.data) || !hasExactKeys(result.data, ['cut', 'status', 'writerEpoch'])
      || !isWorldStorageTransferCut(result.data.cut) || !sameCut(result.data.cut, entry.cut)
      || (result.data.status !== 'activated' && result.data.status !== 'aborted')
      || typeof result.data.writerEpoch !== 'string' || !/^[1-9][0-9]{0,19}$/.test(result.data.writerEpoch)
      || BigInt(result.data.writerEpoch) > 18_446_744_073_709_551_615n) return status(entry);
    await checkpoint(journal, entry, result.data.status);
    return status(entry);
  } catch (error) {
    if (error instanceof WorldPrivateAdmissionError) return dispatched && entry ? status(entry)
      : { outcome: 'not-attempted', reason: 'unauthorized' };
    // File/transport failure cannot establish rollback, a new ID, or an absent original cut.
    return entry ? { outcome: 'status', transfer: { ...publicStatus(entry), phase: 'unknown' } }
      : { outcome: 'unknown', reason: 'storage-unavailable' };
  }
}

async function checkpoint(journal: Entry[], entry: Entry, phase: Phase, error?: Failure, admit?: () => Promise<void>): Promise<void> {
  entry.phase = phase;
  if (error) entry.error = error;
  else delete entry.error;
  await saveJournal(journal, admit);
}
function status(entry: Entry): WorldStorageTransferResult { return { outcome: 'status', transfer: publicStatus(entry) }; }
function publicStatus(entry: Entry): WorldStorageTransferStatus {
  return { transferId: entry.transferId, world: entry.world, targetStorageId: entry.targetStorageId,
    phase: entry.phase, action: entry.action, ...(entry.error ? { error: entry.error } : {}) };
}
function domainResult(outcome: RuntimeHostControlOutcome):
  | { kind: 'success'; data: unknown }
  | { kind: 'failure' | 'unknown'; error?: Failure } {
  if (outcome.kind !== 'succeeded' && outcome.kind !== 'unknown') return { kind: 'unknown' };
  const body = outcome.result;
  if (!isRecord(body)) return { kind: 'unknown' };
  if (outcome.kind === 'succeeded' && hasExactKeys(body, ['success', 'data']) && body.success === true) return { kind: 'success', data: body.data };
  if (hasExactKeys(body, ['success', 'error']) && body.success === false && failure(body.error)) {
    return { kind: outcome.kind === 'unknown' ? 'unknown' : 'failure', error: body.error };
  }
  return { kind: 'unknown' };
}
async function readJournal(): Promise<Entry[]> {
  let bytes: Buffer;
  try { bytes = await readFile(join(app.getPath('userData'), JOURNAL_FILE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('world.storage_transfer_unavailable');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(value) || !value.every(validEntry)
    || new Set(value.map((entry) => entry.transferId)).size !== value.length) throw new Error('world.storage_transfer_unavailable');
  return value;
}
async function saveJournal(journal: Entry[], admit?: () => Promise<void>): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(journal));
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('world.storage_transfer_unavailable');
  const path = join(app.getPath('userData'), JOURNAL_FILE);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (admit) await admit();
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}
function validInput(value: unknown): value is WorldStorageTransferInput {
  if (!isRecord(value)) return false;
  if (value.action === 'prepare') return hasExactKeys(value, ['action', 'world', 'targetStorageId']) && isWorldRef(value.world) && identifier(value.targetStorageId);
  if (value.action === 'status' && hasExactKeys(value, ['action', 'world'])) return isWorldRef(value.world);
  return (value.action === 'resume' || value.action === 'abort' || value.action === 'status')
    && hasExactKeys(value, ['action', 'transferId']) && identifier(value.transferId);
}
function validEntry(value: unknown): value is Entry {
  if (!isRecord(value) || !identifier(value.transferId) || !isWorldRef(value.world) || !identifier(value.targetStorageId)
    || !['unknown', 'prepared', 'activated', 'aborted', 'failed'].includes(String(value.phase))
    || (value.action !== 'resume' && value.action !== 'abort')
    || !Object.keys(value).every((key) => ['transferId', 'world', 'targetStorageId', 'phase', 'action', 'error', 'cut'].includes(key))
    || (value.error !== undefined && !failure(value.error))) return false;
  return value.cut === undefined ? value.phase !== 'prepared' && value.phase !== 'activated' && value.phase !== 'aborted'
    : isWorldStorageTransferCut(value.cut) && value.cut.transferId === value.transferId
      && sameWorld(value.cut.world, value.world) && value.cut.targetStorageId === value.targetStorageId;
}
function failure(value: unknown): value is Failure {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
    && identifier(value.diagnosticId) && typeof value.stage === 'string' && isRecord(value.details) && isRecord(value.recovery);
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value); }
function sameWorld(left: WorldRef, right: WorldRef): boolean { return left.tenantId === right.tenantId && left.worldId === right.worldId; }
function sameCut(left: WorldStorageTransferCut, right: WorldStorageTransferCut): boolean {
  return sameWorld(left.world, right.world) && left.transferId === right.transferId
    && left.sourceStorageId === right.sourceStorageId && left.targetStorageId === right.targetStorageId
    && left.sourceEpoch === right.sourceEpoch && left.targetEpoch === right.targetEpoch;
}
