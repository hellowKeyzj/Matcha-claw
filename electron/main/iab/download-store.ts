import { randomUUID } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';

import type { IabDownload } from '../../../src/types/desktop/iab';
import { replacePrivateFile } from './persistence';

export type DownloadStatus = IabDownload['status'];
export type DownloadRecord = IabDownload & { savePath: string; recovery?: string; recoveryIdentity?: string };
export interface DownloadControl {
  getReceivedBytes(): number;
  getTotalBytes(): number;
  pause(): void;
  resume(): void | Promise<void>;
  cancel(): void;
  pauseForShutdown?(): boolean;
}
export interface DownloadRecoveryDriver {
  ready: Promise<void>;
  refresh(id?: string): Promise<void>;
  flush(): Promise<void>;
  retryCleanup(): Promise<void>;
  prepareForShutdown(): Promise<void>;
  cancelShutdown(): void;
}
const MAX_BYTES = 16_777_216;
const STATUSES = new Set(['progressing', 'paused', 'completed', 'cancelled', 'interrupted']);
export const isFileIdentity = (value: unknown): value is string => typeof value === 'string' && value.length <= 100 && /^\d+:[1-9]\d*$/.test(value);

export class DownloadStore {
  private readonly path: string;
  private ready?: Promise<void>;
  private readonly records = new Map<string, DownloadRecord>();
  readonly active = new Map<string, DownloadControl>();
  private readonly recoverable = new Map<string, { resume(): Promise<void>; cancel(): void }>();
  private readonly missing = new Map<string, boolean>();
  private readonly listeners = new Set<() => void>();
  private writing?: Promise<void>;
  private lastWrite: Promise<void> = Promise.resolve();
  private dirty = false;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private shutdown = false;
  private initialized = false;
  private loadFailure?: unknown;
  recovery?: DownloadRecoveryDriver;

  constructor(root: string, private readonly onError: (error: unknown) => void) {
    this.path = join(root, 'aw-browser-downloads.json');
  }

  initialize(): Promise<void> {
    return this.ready ??= this.load().then(() => { this.initialized = true; }).catch((error) => { this.loadFailure = error; throw error; });
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      if ((await stat(this.path)).size > MAX_BYTES) throw new Error('Download history exceeds size limit');
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Download history exceeds size limit');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Invalid download history');
    let finishedCount = 0;
    for (const value of parsed) {
      const record = value as DownloadRecord;
      if (!record || typeof record !== 'object' || typeof record.id !== 'string' ||
        typeof record.filename !== 'string' || record.filename.length > 1_000 ||
        typeof record.savePath !== 'string' || !isAbsolute(record.savePath) || !STATUSES.has(record.status) ||
        !Number.isFinite(record.startedAt) || record.startedAt <= 0 || !Number.isFinite(new Date(record.startedAt).getTime()) ||
        !Number.isFinite(record.updatedAt) || !Number.isFinite(record.receivedBytes) || record.receivedBytes < 0 ||
        !Number.isFinite(record.totalBytes) || record.totalBytes < 0 || this.records.has(record.id)) continue;
      const recovery = typeof record.recovery === 'string' && record.recovery.length > 0 && record.recovery.length <= 64_000 ? record.recovery : undefined;
      const recoveryIdentity = isFileIdentity(record.recoveryIdentity) && /^[\w-]+$/.test(record.id) ? record.recoveryIdentity : undefined;
      if (recovery === undefined && recoveryIdentity === undefined && finishedCount++ >= 200) continue;
      this.records.set(record.id, {
        id: record.id, filename: record.filename, savePath: record.savePath,
        status: record.status === 'progressing' || record.status === 'paused' ? 'interrupted' : record.status,
        receivedBytes: record.receivedBytes, totalBytes: record.totalBytes,
        startedAt: record.startedAt, updatedAt: record.updatedAt,
        ...(recovery === undefined ? {} : { recovery }), ...(recoveryIdentity === undefined ? {} : { recoveryIdentity }),
      });
    }
    this.emit();
  }

  assertCanStart(): void {
    if (this.shutdown) throw new Error('Downloads are unavailable during application shutdown');
    if (this.loadFailure !== undefined) throw this.loadFailure;
    if (!this.initialized) throw new Error('Download history is not ready');
  }

  start(item: DownloadControl, filename: string, savePath: string): string {
    this.assertCanStart();
    const id = randomUUID();
    const now = Date.now();
    this.records.set(id, { id, filename, savePath, status: 'progressing', receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(), startedAt: now, updatedAt: now });
    this.active.set(id, item);
    this.changed(true);
    return id;
  }

  update(id: string, item: DownloadControl, status: DownloadStatus): void {
    const record = this.records.get(id);
    if (!record) return;
    Object.assign(record, { status, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), updatedAt: Date.now() });
    this.changed();
  }

  finish(id: string, item: DownloadControl, status: DownloadStatus, savePath?: string): void {
    const record = this.records.get(id);
    if (!record) return;
    if (status === 'completed' || status === 'cancelled') { delete record.recovery; this.recoverable.delete(id); }
    if (savePath !== undefined) {
      if (!isAbsolute(savePath)) throw new Error('Download path must be absolute');
      record.savePath = savePath;
      record.filename = basename(savePath);
      this.missing.delete(id);
    }
    this.update(id, item, status);
    this.active.delete(id);
    this.trim();
    this.changed(true);
  }

  setRecovery(id: string, encrypted?: string): void {
    const record = this.records.get(id);
    if (!record || record.recovery === encrypted) return;
    if (encrypted === undefined) delete record.recovery;
    else record.recovery = encrypted;
    this.changed(true, false);
  }

  setIdentity(id: string, identity?: string): void {
    const record = this.records.get(id);
    if (!record || record.recoveryIdentity === identity) return;
    if (identity === undefined) delete record.recoveryIdentity;
    else {
      if (!isFileIdentity(identity)) throw new Error('Invalid recovery file identity');
      record.recoveryIdentity = identity;
    }
    this.changed(true, false);
  }

  setRecoveryControl(id: string, control?: { resume(): Promise<void>; cancel(): void }, paused = false): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (control) { this.recoverable.set(id, control); record.status = paused ? 'paused' : 'interrupted'; }
    else if (this.recoverable.delete(id) && record.status === 'paused') record.status = 'interrupted';
    this.changed();
    return true;
  }

  bindRecovered(id: string, item: DownloadControl): void {
    this.assertCanStart();
    if (!this.records.has(id) || this.active.has(id)) throw new Error('Download recovery is unavailable');
    this.recoverable.delete(id);
    this.active.set(id, item);
    this.update(id, item, 'progressing');
  }

  endRecovery(id: string): void {
    this.recoverable.delete(id);
    const record = this.records.get(id);
    if (!record) return;
    delete record.recovery;
    record.status = 'cancelled';
    this.changed(true);
  }

  completeRecovery(id: string, length: number): void {
    const record = this.records.get(id);
    if (!record) return;
    delete record.recovery;
    this.recoverable.delete(id);
    this.active.delete(id);
    Object.assign(record, { status: 'completed', receivedBytes: length, totalBytes: length, updatedAt: Date.now() });
    this.missing.delete(id);
    this.changed(true);
  }

  async recoveryRecords(): Promise<DownloadRecord[]> {
    await this.initialize();
    return this.sorted().filter((record) => record.recovery !== undefined || record.recoveryIdentity !== undefined).map((record) => ({ ...record }));
  }

  async list(refresh = false): Promise<IabDownload[]> {
    await this.initialize();
    await this.recovery?.ready;
    if (refresh) await this.recovery?.refresh();
    let changed = false;
    const result = await Promise.all(this.sorted().map(async ({ savePath, recovery: _recovery, recoveryIdentity: _identity, ...record }) => {
      const entry: IabDownload = this.recoverable.has(record.id) ? { ...record, canResume: true } : record;
      if (record.status !== 'completed') return entry;
      const previous = this.missing.get(record.id);
      if (refresh) {
        try { await this.checkMissing(record.id, savePath, false); } catch (error) { this.onError(error); }
      }
      const missing = this.missing.get(record.id);
      if (missing !== previous && missing !== undefined && (previous !== undefined || missing)) changed = true;
      return missing === undefined ? entry : { ...entry, fileMissing: missing };
    }));
    if (changed) this.emit();
    return result;
  }

  private async checkMissing(id: string, path: string, emit = true): Promise<boolean> {
    let missing: boolean;
    try { missing = !(await lstat(path)).isFile(); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      missing = true;
    }
    if (this.records.get(id)?.savePath === path) {
      const previous = this.missing.get(id);
      this.missing.set(id, missing);
      if (emit && previous !== missing && (previous !== undefined || missing)) this.emit();
    }
    return missing;
  }

  async availablePath(id: string): Promise<string | null> {
    await this.initialize();
    const record = this.records.get(id);
    if (!record || record.status !== 'completed') throw new Error('Completed download is unavailable');
    const path = record.savePath;
    const missing = await this.checkMissing(id, path);
    if (this.records.get(id)?.savePath !== path) throw new Error('Completed download is unavailable');
    return missing ? null : path;
  }

  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    await this.initialize();
    await this.recovery?.ready;
    if (action === 'resume') { this.assertCanStart(); await this.recovery?.refresh(id); }
    const item = this.active.get(id);
    if (!item) {
      const recovery = this.recoverable.get(id);
      if (recovery && action === 'resume') return recovery.resume();
      if (recovery && action === 'cancel') { recovery.cancel(); return; }
      throw new Error('Active download is unavailable');
    }
    if (action === 'cancel') item.cancel();
    else if (action === 'pause') { item.pause(); this.update(id, item, 'paused'); }
    else { await item.resume(); this.update(id, item, 'progressing'); }
    await this.save();
  }

  private isProtected(id: string): boolean {
    return this.active.has(id) || this.recoverable.has(id) || this.records.get(id)?.recoveryIdentity !== undefined;
  }

  async remove(id: string): Promise<void> {
    await this.initialize();
    await this.recovery?.ready;
    await this.recovery?.retryCleanup();
    if (this.isProtected(id)) throw new Error('Cannot remove an active download or pending recovery cleanup');
    const record = this.records.get(id);
    if (!record) throw new Error('Download record is unavailable');
    this.records.delete(id);
    this.emit();
    try { await this.save(); this.missing.delete(id); }
    catch (error) { this.records.set(id, record); this.emit(); throw error; }
  }

  async clear(): Promise<void> {
    await this.initialize();
    await this.recovery?.ready;
    await this.recovery?.retryCleanup();
    const removed = [...this.records].filter(([id]) => !this.isProtected(id));
    for (const [id] of removed) this.records.delete(id);
    this.emit();
    try { await this.save(); for (const [id] of removed) this.missing.delete(id); }
    catch (error) { for (const [id, record] of removed) this.records.set(id, record); this.emit(); throw error; }
  }

  private sorted(): DownloadRecord[] { return [...this.records.values()].sort((left, right) => right.startedAt - left.startedAt); }
  private trim(): void {
    for (const record of this.sorted().filter((record) => !this.isProtected(record.id) && record.recovery === undefined).slice(200)) {
      this.records.delete(record.id);
      this.missing.delete(record.id);
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch (error) { this.onError(error); } } }
  private changed(immediate = false, emit = true): void {
    this.dirty = true;
    if (emit) this.emit();
    if (immediate) { void this.save().catch(this.onError); return; }
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => { this.writeTimer = undefined; void this.save().catch(this.onError); }, 1_000);
    this.writeTimer.unref();
  }
  private save(): Promise<void> {
    this.dirty = true;
    if (this.writing) return this.writing;
    const writing = Promise.resolve().then(async () => {
      try {
        await this.initialize();
        while (this.dirty) {
          this.dirty = false;
          this.trim();
          const contents = `${JSON.stringify(this.sorted(), null, 2)}\n`;
          if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error('Download history exceeds size limit');
          await replacePrivateFile(this.path, contents);
        }
      } catch (error) { this.dirty = true; throw error; }
      finally { this.writing = undefined; }
    });
    this.writing = writing;
    this.lastWrite = writing;
    return writing;
  }

  async flush(): Promise<void> {
    await this.initialize();
    await this.recovery?.flush();
    clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    do {
      if (this.dirty && !this.writing) this.save();
      await (this.writing ?? this.lastWrite);
    } while (this.writing || this.dirty);
  }

  async flushForShutdown(): Promise<void> {
    this.shutdown = true;
    await this.initialize();
    await this.recovery?.ready;
    const errors: unknown[] = [];
    try { await this.recovery?.prepareForShutdown(); } catch (error) { errors.push(error); }
    for (const [id, item] of this.active) {
      try {
        const paused = item.pauseForShutdown ? item.pauseForShutdown() : (item.pause(), true);
        if (this.active.get(id) === item && paused) this.update(id, item, 'paused');
      } catch (error) { errors.push(error); }
    }
    try { await this.flush(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Download shutdown checkpoint failed');
  }

  cancelShutdown(): void {
    this.shutdown = false;
    this.recovery?.cancelShutdown();
  }

  dispose(): void { clearTimeout(this.writeTimer); this.listeners.clear(); }
}
