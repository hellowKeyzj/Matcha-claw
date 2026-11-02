import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { safeStorage, type DownloadItem, type Event, type Session, type WebContents } from 'electron';

import { DownloadStore, isFileIdentity, type DownloadControl, type DownloadStatus } from './download-store';

type Checkpoint = {
  urlChain: string[]; mimeType: string; offset: number; length: number; eTag: string;
  lastModified: string; startTime: number; paused: boolean; identity: string;
};
type Transfer = {
  id: string; path: string; item?: DownloadItem; checkpoint?: Checkpoint; cleanupIdentity?: string;
  paused: boolean; discarded: boolean; received: number; total: number; reserved?: boolean; attempt?: string;
  latestSnapshot?: Checkpoint;
  needsValidation?: boolean;
  discarding?: Promise<void>;
};
type RecoveryAttempt = { transfer: Transfer; attempt: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

class InvalidCheckpointError extends Error {}

export function pathKey(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
export async function fileStat(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
const fileIdentity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}`;
const checkpointPath = (transfer: Transfer): string => join(dirname(transfer.path), '.aw-download-resume', `${transfer.id}.partial`);

function isCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Checkpoint;
  return Array.isArray(checkpoint.urlChain) && checkpoint.urlChain.length > 0 && checkpoint.urlChain.length <= 32 &&
    checkpoint.urlChain.every((url) => typeof url === 'string' && url.length <= 8_192 && /^https?:\/\//i.test(url)) &&
    Number.isSafeInteger(checkpoint.offset) && checkpoint.offset >= 0 && Number.isSafeInteger(checkpoint.length) && checkpoint.length > checkpoint.offset &&
    typeof checkpoint.mimeType === 'string' && typeof checkpoint.eTag === 'string' && typeof checkpoint.lastModified === 'string' &&
    Number.isFinite(checkpoint.startTime) && typeof checkpoint.paused === 'boolean' && isFileIdentity(checkpoint.identity);
}

export class DownloadRecovery {
  readonly ready: Promise<void>;
  private readonly transfers = new Map<string, Transfer>();
  private readonly pendingCleanup = new Map<string, Transfer>();
  private readonly pendingCheckpoints = new Set<string>();
  private readonly checkpoints = new Map<string, Promise<void>>();
  private readonly resuming = new Map<string, Promise<void>>();
  private readonly completing = new Set<Promise<void>>();
  private stopping = false;
  private readonly attempts = new Map<string, RecoveryAttempt>();
  private readonly cancelledAttempts = new Map<string, ReturnType<typeof setTimeout>>();
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private encryptionAvailable = false;

  constructor(private readonly session: Session, private readonly store: DownloadStore,
    private readonly reserve: (path: string) => boolean, private readonly release: (path: string) => void,
    private readonly onError: (error: unknown) => void) {
    this.session.on('will-download', this.onDownload);
    this.store.recovery = this;
    this.ready = this.restore().catch(this.onError);
  }

  private async restore(): Promise<void> {
    this.encryptionAvailable = safeStorage.isEncryptionAvailable();
    for (const record of await this.store.recoveryRecords()) {
      if (this.disposed) return;
      if (this.transfers.has(record.id)) continue;
      if (!/^[\w-]{1,128}$/.test(record.id)) { this.onError(new Error('Invalid download recovery ID')); continue; }
      const transfer: Transfer = { id: record.id, path: record.savePath, cleanupIdentity: record.recoveryIdentity,
        paused: false, discarded: false, received: record.receivedBytes, total: record.totalBytes };
      if (!record.recovery) { await this.discard(transfer); continue; }
      if (!this.encryptionAvailable) { this.onError(new Error('Download recovery encryption is unavailable')); continue; }
      try {
        const value: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(record.recovery, 'base64')));
        const identity = (value as Checkpoint | null)?.identity;
        if (transfer.cleanupIdentity === undefined && isFileIdentity(identity)) {
          transfer.cleanupIdentity = identity;
          this.store.setIdentity(record.id, identity);
        }
        if (!isCheckpoint(value) || record.status === 'completed' || record.status === 'cancelled' ||
          (transfer.cleanupIdentity !== undefined && transfer.cleanupIdentity !== value.identity)) throw new InvalidCheckpointError('Invalid download checkpoint');
        transfer.checkpoint = value;
        transfer.cleanupIdentity = value.identity;
        transfer.paused = value.paused;
        transfer.received = value.offset;
        transfer.total = value.length;
        this.store.setIdentity(record.id, value.identity);
      } catch (error) { await this.discard(transfer); this.onError(error); continue; }
      this.transfers.set(record.id, transfer);
      await this.offer(record.id);
    }
  }

  track(id: string, path: string, item: DownloadItem): DownloadControl {
    const transfer: Transfer = { id, path, item, paused: item.isPaused(), discarded: false,
      received: item.getReceivedBytes(), total: item.getTotalBytes() };
    this.transfers.set(id, transfer);
    void this.ready.then(() => this.checkpoint(id, true)).catch(this.onError);
    return this.controlFor(transfer, item);
  }

  private controlFor(transfer: Transfer, item: DownloadItem): DownloadControl {
    return {
      getReceivedBytes: () => { try { transfer.received = item.getReceivedBytes(); } catch { /* Native item was destroyed. */ } return transfer.received; },
      getTotalBytes: () => { try { transfer.total = item.getTotalBytes(); } catch { /* Native item was destroyed. */ } return transfer.total; },
      pause: () => { item.pause(); transfer.paused = true; void this.checkpoint(transfer.id, true).catch(this.onError); },
      resume: () => { item.resume(); transfer.paused = false; void this.checkpoint(transfer.id, true).catch(this.onError); },
      cancel: () => {
        transfer.discarded = true;
        void this.discard(transfer).catch(this.onError);
        item.cancel();
      },
    };
  }

  checkpoint(id: string, immediate = false, required = false): Promise<void> {
    const transfer = this.transfers.get(id);
    if (!this.encryptionAvailable || this.disposed || !transfer?.item || transfer.discarded) return Promise.resolve();
    if (!immediate) {
      this.pendingCheckpoints.add(id);
      if (!this.checkpointTimer) {
        this.checkpointTimer = setTimeout(() => {
          this.checkpointTimer = undefined;
          const ids = [...this.pendingCheckpoints];
          this.pendingCheckpoints.clear();
          for (const pendingId of ids) void this.checkpoint(pendingId, true).catch(this.onError);
        }, 5_000);
        this.checkpointTimer.unref();
      }
      return Promise.resolve();
    }
    this.pendingCheckpoints.delete(id);
    // Snapshot native getters before yielding: Electron invalidates DownloadItem after its done callback.
    try {
      const item = transfer.item;
      const snapshot: Checkpoint = { urlChain: item.getURLChain(), mimeType: item.getMimeType(),
        offset: item.getReceivedBytes(), length: item.getTotalBytes(), eTag: item.getETag(),
        lastModified: item.getLastModifiedTime(), startTime: item.getStartTime(), paused: transfer.paused, identity: '0:1' };
      transfer.received = snapshot.offset;
      transfer.total = snapshot.length;
      if (isCheckpoint(snapshot) && Buffer.byteLength(JSON.stringify(snapshot)) <= 40_000) transfer.latestSnapshot = snapshot;
    } catch (error) {
      if (required) return Promise.reject(error);
    }
    const snapshot = transfer.latestSnapshot;
    if (!snapshot) return Promise.resolve();
    const previous = this.checkpoints.get(id) ?? Promise.resolve();
    const checkpoint = previous.catch(() => {}).then(() => this.saveCheckpoint(transfer, snapshot, required));
    this.checkpoints.set(id, checkpoint);
    void checkpoint.finally(() => { if (this.checkpoints.get(id) === checkpoint) this.checkpoints.delete(id); }).catch(() => {});
    return checkpoint;
  }

  private async saveCheckpoint(transfer: Transfer, checkpoint: Checkpoint, required: boolean): Promise<void> {
    if (transfer.discarded || this.disposed) return;
    try {
      const offset = checkpoint.offset;
      const path = checkpointPath(transfer);
      const directory = dirname(path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('Invalid checkpoint directory');
      let saved = await fileStat(path);
      const destination = await fileStat(transfer.path);
      const sourcePath = destination ? transfer.path : `${transfer.path}.crdownload`;
      const source = destination ?? await fileStat(sourcePath);
      if (source && (!saved || fileIdentity(source) !== fileIdentity(saved))) {
        if (!source.isFile() || source.isSymbolicLink()) throw new Error('Invalid partial file');
        if (saved) {
          if (!transfer.checkpoint || fileIdentity(saved) !== transfer.checkpoint.identity) throw new Error('Checkpoint was replaced');
          if (!await this.cleanup(transfer, false)) throw new Error('Download recovery cleanup is pending');
          await unlink(path);
        }
        await link(sourcePath, path);
        saved = await lstat(path, { bigint: true });
        if (fileIdentity(saved) !== fileIdentity(source)) throw new Error('Partial file changed during checkpoint');
      }
      if (!saved || !saved.isFile() || saved.isSymbolicLink()) {
        if (required && (transfer.checkpoint || offset > 0)) throw new Error('Download checkpoint is unavailable');
        return;
      }
      transfer.cleanupIdentity = fileIdentity(saved);
      if (transfer.discarded || this.disposed) return;
      const snapshot = { ...checkpoint, offset: saved.size < BigInt(offset) ? Number(saved.size) : offset, identity: transfer.cleanupIdentity };
      transfer.checkpoint = snapshot;
      transfer.cleanupIdentity = snapshot.identity;
      this.store.setIdentity(transfer.id, snapshot.identity);
      this.store.setRecovery(transfer.id, safeStorage.encryptString(JSON.stringify(snapshot)).toString('base64'));
    } catch (error) { if (required) throw error; this.onError(error); }
  }

  async finished(id: string, status: DownloadStatus): Promise<DownloadStatus> {
    const transfer = this.transfers.get(id);
    if (!transfer) return status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'interrupted';
    this.releaseReservation(transfer);
    const finalCheckpoint = status === 'completed' || transfer.discarded ? undefined : this.checkpoint(id, true);
    if (status === 'completed' || transfer.discarded) {
      await this.discard(transfer);
      return status === 'completed' ? 'completed' : 'cancelled';
    }
    await finalCheckpoint;
    transfer.item = undefined;
    await this.cleanupAttempt(transfer);
    if (!transfer.checkpoint) this.transfers.delete(id);
    return 'interrupted';
  }

  async offer(id: string): Promise<void> {
    const transfer = this.transfers.get(id);
    if (!transfer?.checkpoint || transfer.discarded || this.disposed) return;
    try {
      const saved = await this.validateCheckpoint(transfer);
      await this.cleanup(transfer, false);
      if (await this.completeIfAlreadySaved(transfer, saved)) return;
      transfer.needsValidation = false;
      if (!this.store.setRecoveryControl(id, {
        resume: () => this.resume(transfer),
        cancel: () => {
          transfer.discarded = true;
          void this.discard(transfer).then(() => this.store.endRecovery(id)).catch(this.onError);
        },
      }, transfer.paused)) await this.discard(transfer);
    } catch (error) {
      if (error instanceof InvalidCheckpointError) await this.discard(transfer);
      else { transfer.needsValidation = true; this.store.setRecoveryControl(id); }
      this.onError(error);
    }
  }

  async refresh(id?: string): Promise<void> {
    await this.ready;
    for (const transfer of this.transfers.values()) {
      if ((id === undefined ? transfer.needsValidation : transfer.id === id) && !transfer.item && !this.resuming.has(transfer.id)) {
        await this.offer(transfer.id);
      }
    }
  }

  private async validateCheckpoint(transfer: Transfer): Promise<BigIntStats> {
    const path = checkpointPath(transfer);
    const directory = await lstat(dirname(path));
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new InvalidCheckpointError('Invalid checkpoint directory');
    const saved = await lstat(path, { bigint: true });
    if (!saved.isFile() || saved.isSymbolicLink() ||
      fileIdentity(saved) !== transfer.checkpoint?.identity || saved.size < BigInt(transfer.checkpoint.offset)) {
      throw new InvalidCheckpointError('Invalid download checkpoint');
    }
    return saved;
  }

  private async completeIfAlreadySaved(transfer: Transfer, saved: BigIntStats): Promise<boolean> {
    const checkpoint = transfer.checkpoint!;
    const destination = await fileStat(transfer.path);
    if (!destination?.isFile() || destination.isSymbolicLink() || fileIdentity(destination) !== fileIdentity(saved) ||
      destination.size !== BigInt(checkpoint.length)) return false;
    this.store.completeRecovery(transfer.id, checkpoint.length);
    await this.discard(transfer);
    return true;
  }

  private resume(transfer: Transfer): Promise<void> {
    if (this.resuming.has(transfer.id)) return Promise.reject(new Error('Download recovery is already starting'));
    const resuming = this.resumeTransfer(transfer).finally(() => this.resuming.delete(transfer.id));
    this.resuming.set(transfer.id, resuming);
    return resuming;
  }

  private async resumeTransfer(transfer: Transfer): Promise<void> {
    await this.ready;
    this.store.assertCanStart();
    if (this.disposed || this.stopping || transfer.discarded || transfer.item) throw new Error('Download recovery is unavailable');
    if ([...this.attempts.values()].some((attempt) => attempt.transfer === transfer)) throw new Error('Download recovery is already starting');
    let saved: BigIntStats;
    try {
      saved = await this.validateCheckpoint(transfer);
      if (await this.completeIfAlreadySaved(transfer, saved)) return;
    } catch (error) {
      if (error instanceof InvalidCheckpointError) await this.discard(transfer);
      else { transfer.needsValidation = true; this.store.setRecoveryControl(transfer.id); }
      throw error;
    }
    const checkpoint = transfer.checkpoint!;
    const destination = await fileStat(transfer.path);
    if (destination && (!destination.isFile() || destination.isSymbolicLink() || fileIdentity(destination) !== fileIdentity(saved) ||
      destination.size >= BigInt(checkpoint.length))) throw new Error('The download destination already exists');
    if (!this.reserve(transfer.path)) throw new Error('The download destination is in use');
    transfer.reserved = true;
    try {
      if (destination) {
        const current = await fileStat(transfer.path);
        if (!current || fileIdentity(current) !== fileIdentity(saved) || current.isSymbolicLink()) throw new Error('The download destination changed');
        await unlink(transfer.path);
      }
      const actualPath = await realpath(checkpointPath(transfer));
      // Recheck the anchored identity before truncating; never truncate a replacement or symlink target.
      const file = await open(actualPath, 'r+');
      try {
        const actual = await file.stat({ bigint: true });
        if (!actual.isFile() || fileIdentity(actual) !== checkpoint.identity) throw new Error('Download checkpoint was replaced');
        await file.truncate(checkpoint.offset);
      } finally { await file.close(); }
      const attemptPath = join(dirname(actualPath), `${transfer.id}-${randomUUID()}.partial`);
      await link(actualPath, attemptPath);
      const attemptStat = await lstat(attemptPath, { bigint: true });
      if (!attemptStat.isFile() || attemptStat.isSymbolicLink() || fileIdentity(attemptStat) !== checkpoint.identity) {
        throw new Error('Download checkpoint was replaced');
      }
      transfer.attempt = attemptPath;
      if (this.disposed || this.stopping || transfer.discarded) {
        await this.cleanupAttempt(transfer);
        throw new Error('Download recovery was cancelled');
      }
      const key = pathKey(attemptPath);
      await new Promise<void>((resolveAttempt, reject) => {
        const timer = setTimeout(() => {
          this.attempts.delete(key);
          this.fenceAttempt(key);
          void this.removeOwnedLink(transfer, attemptPath).catch(this.onError);
          reject(new Error('Download recovery timed out'));
        }, 5_000);
        timer.unref();
        this.attempts.set(key, { transfer, attempt: attemptPath, resolve: resolveAttempt, reject, timer });
        try {
          this.session.createInterruptedDownload({ path: attemptPath, urlChain: checkpoint.urlChain,
            mimeType: checkpoint.mimeType, offset: checkpoint.offset, length: checkpoint.length,
            eTag: checkpoint.eTag, lastModified: checkpoint.lastModified, startTime: checkpoint.startTime });
        } catch {
          clearTimeout(timer);
          this.attempts.delete(key);
          void this.removeOwnedLink(transfer, attemptPath).catch(this.onError);
          reject(new Error('Download recovery failed'));
        }
      });
    } catch (error) { this.releaseReservation(transfer); throw error; }
  }

  private readonly onDownload = (_event: Event, item: DownloadItem, contents: WebContents): void => {
    if (contents || this.disposed || item.getState() !== 'interrupted') return;
    const key = pathKey(item.getSavePath());
    const fence = this.cancelledAttempts.get(key);
    if (fence) { clearTimeout(fence); this.cancelledAttempts.delete(key); item.cancel(); return; }
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    this.attempts.delete(key);
    clearTimeout(attempt.timer);
    const transfer = attempt.transfer;
    try {
      if (transfer.discarded) throw new Error('Download recovery was cancelled');
      item.setSavePath(transfer.path);
      transfer.item = item;
      transfer.paused = false;
      transfer.attempt = attempt.attempt;
      const control = this.controlFor(transfer, item);
      this.store.bindRecovered(transfer.id, control);
      let lastUpdate = 0;
      const updated = (_event: Event, state: string): void => {
        void this.checkpoint(transfer.id).catch(this.onError);
        if (Date.now() - lastUpdate < 250 && state !== 'interrupted') return;
        lastUpdate = Date.now();
        this.store.update(transfer.id, control, item.isPaused() || state === 'interrupted' ? 'paused' : 'progressing');
      };
      item.on('updated', updated);
      item.once('done', (_event, state) => {
        item.removeListener('updated', updated);
        // Cache native bytes/checkpoint while the item is still valid in this callback.
        control.getReceivedBytes();
        control.getTotalBytes();
        const checkpoint = this.checkpoint(transfer.id, true);
        const completing = (async () => {
          let status: DownloadStatus = state;
          if (status === 'completed') {
            try { if (!(await fileStat(transfer.path))?.isFile()) status = 'interrupted'; }
            catch (error) { status = 'interrupted'; this.onError(error); }
          }
          await checkpoint;
          const finished = await this.finished(transfer.id, status);
          this.store.finish(transfer.id, control, finished, status === 'completed' ? transfer.path : undefined);
          await this.offer(transfer.id);
        })();
        this.completing.add(completing);
        void completing.finally(() => this.completing.delete(completing)).catch(this.onError);
      });
      item.resume();
      attempt.resolve();
    } catch (error) {
      try { item.cancel(); } catch (cancelError) { this.onError(cancelError); }
      void this.finished(transfer.id, 'interrupted').then(async (status) => {
        this.store.finish(transfer.id, { getReceivedBytes: () => transfer.received, getTotalBytes: () => transfer.total,
          pause() {}, resume() {}, cancel() {} }, status);
        await this.offer(transfer.id);
      }).catch(this.onError);
      attempt.reject(new Error('Download recovery failed', { cause: error }));
    }
  };

  private releaseReservation(transfer: Transfer): void {
    if (transfer.reserved) { this.release(transfer.path); transfer.reserved = false; }
  }
  private fenceAttempt(key: string): void {
    clearTimeout(this.cancelledAttempts.get(key));
    const timer = setTimeout(() => this.cancelledAttempts.delete(key), 30_000);
    timer.unref();
    this.cancelledAttempts.set(key, timer);
  }
  private cancelAttempts(transfer: Transfer): void {
    for (const [key, attempt] of this.attempts) {
      if (attempt.transfer !== transfer) continue;
      clearTimeout(attempt.timer);
      this.attempts.delete(key);
      this.fenceAttempt(key);
      attempt.reject(new Error('Download recovery was cancelled'));
    }
  }
  private discard(transfer: Transfer): Promise<void> {
    return transfer.discarding ??= this.discardTransfer(transfer);
  }
  private async discardTransfer(transfer: Transfer): Promise<void> {
    transfer.discarded = true;
    this.pendingCheckpoints.delete(transfer.id);
    this.releaseReservation(transfer);
    this.cancelAttempts(transfer);
    await this.checkpoints.get(transfer.id)?.catch(() => {});
    this.store.setRecoveryControl(transfer.id);
    this.store.setRecovery(transfer.id);
    if (transfer.cleanupIdentity) {
      this.store.setIdentity(transfer.id, transfer.cleanupIdentity);
      if (await this.cleanup(transfer)) { this.pendingCleanup.delete(transfer.id); this.store.setIdentity(transfer.id); }
      else this.pendingCleanup.set(transfer.id, transfer);
    }
    this.transfers.delete(transfer.id);
  }
  private async cleanupAttempt(transfer: Transfer): Promise<void> {
    if (transfer.attempt && await this.removeOwnedLink(transfer, transfer.attempt)) transfer.attempt = undefined;
  }
  private async cleanup(transfer: Transfer, includeCheckpoint = true): Promise<boolean> {
    let cleaned = !includeCheckpoint || await this.removeOwnedLink(transfer, checkpointPath(transfer));
    const directory = dirname(checkpointPath(transfer));
    try {
      const stat = await fileStat(directory);
      if (!stat) return cleaned;
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      for (const name of await readdir(directory)) {
        if (name.startsWith(`${transfer.id}-`) && name.endsWith('.partial') && /^[\w-]+\.partial$/.test(name)) {
          if (!await this.removeOwnedLink(transfer, join(directory, name))) cleaned = false;
        }
      }
      return cleaned;
    } catch (error) { this.onError(error); return false; }
  }
  private async removeOwnedLink(transfer: Transfer, path: string): Promise<boolean> {
    try {
      const directory = await fileStat(dirname(path));
      if (!directory) return true;
      if (directory.isSymbolicLink() || !directory.isDirectory()) return false;
      const saved = await fileStat(path);
      if (saved && transfer.cleanupIdentity && fileIdentity(saved) === transfer.cleanupIdentity && !saved.isSymbolicLink()) await unlink(path);
      return true;
    } catch (error) { this.onError(error); return false; }
  }

  async retryCleanup(): Promise<void> {
    for (const [id, transfer] of this.pendingCleanup) {
      if (await this.cleanup(transfer)) { this.pendingCleanup.delete(id); this.store.setIdentity(id); }
    }
  }
  async prepareForShutdown(): Promise<void> {
    this.stopping = true;
    for (const { transfer } of [...this.attempts.values()]) {
      this.cancelAttempts(transfer);
      await this.cleanupAttempt(transfer);
      this.releaseReservation(transfer);
    }
    await Promise.allSettled([...this.resuming.values()]);
  }
  cancelShutdown(): void { this.stopping = false; }
  async flush(): Promise<void> {
    await this.ready;
    await Promise.all([...this.transfers.values()].flatMap((transfer) => transfer.discarding ? [transfer.discarding] : []));
    await Promise.all([...this.completing]);
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    this.pendingCheckpoints.clear();
    await this.retryCleanup();
    const results = await Promise.allSettled([...this.transfers.keys()].map((id) => this.checkpoint(id, true, true)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Download recovery checkpoint failed');
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.checkpointTimer);
    this.pendingCheckpoints.clear();
    this.session.removeListener('will-download', this.onDownload);
    for (const attempt of this.attempts.values()) { clearTimeout(attempt.timer); attempt.reject(new Error('Download recovery was disposed')); }
    this.attempts.clear();
    for (const timer of this.cancelledAttempts.values()) clearTimeout(timer);
    this.cancelledAttempts.clear();
    // Shutdown flush owns checkpoint lifetime; disposing must not erase resumable files or records.
    for (const transfer of this.transfers.values()) this.releaseReservation(transfer);
  }
}
