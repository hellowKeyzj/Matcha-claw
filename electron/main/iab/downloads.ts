import { existsSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { shell, type DownloadItem, type Event, type Session, type WebContents } from 'electron';

import type { IabDownload, IabDownloadCommand } from '../../../src/types/desktop/iab';
import type { IabDownloadCaptureOptions, IabDownloadsOptions } from './contracts';
import { DownloadCapture, downloadFilename } from './download-capture';
import { DownloadRecovery, fileStat, pathKey } from './download-recovery';
import { DownloadStore, type DownloadStatus } from './download-store';

export class IabDownloads {
  private readonly store: DownloadStore;
  private readonly recovery: DownloadRecovery;
  private readonly captures: DownloadCapture;
  private readonly tabs = new Map<WebContents, string>();
  private readonly reserved = new Set<string>();
  private readonly finishing = new Set<Promise<void>>();
  private ready?: Promise<void>;
  private preparingQuit?: Promise<void>;
  private disposed = false;
  private periodicTimer?: ReturnType<typeof setInterval>;

  constructor(root: string, private readonly session: Session, private readonly options: IabDownloadsOptions) {
    this.store = new DownloadStore(root, this.onError);
    this.captures = new DownloadCapture(this.store);
    this.recovery = new DownloadRecovery(session, this.store, this.reserve, this.release, this.onError);
    // Capture is dispatched first in this listener; the recovery driver handles ownerless native items.
    session.prependListener('will-download', this.onDownload);
  }

  private readonly onError = (error: unknown): void => {
    this.options.log?.error('[iab-download] operation failed', error instanceof Error ? error : new Error(String(error)));
  };
  private readonly reserve = (path: string): boolean => {
    const key = pathKey(path);
    if (this.reserved.has(key)) return false;
    this.reserved.add(key);
    return true;
  };
  private readonly release = (path: string): void => { this.reserved.delete(pathKey(path)); };

  initialize(): Promise<void> {
    return this.ready ??= (async () => {
      await Promise.all([this.store.initialize(), this.recovery.ready]);
      if (this.disposed) return;
      this.periodicTimer = setInterval(() => { void this.store.flush().catch(this.onError); }, 30_000);
      this.periodicTimer.unref();
    })();
  }

  observeTab(tabId: string, contents: WebContents): () => void {
    this.tabs.set(contents, tabId);
    const dispose = (): void => {
      if (this.tabs.get(contents) === tabId) this.tabs.delete(contents);
      contents.removeListener('destroyed', dispose);
    };
    contents.once('destroyed', dispose);
    return dispose;
  }

  private readonly onDownload = (event: Event, item: DownloadItem, contents: WebContents): void => {
    if (this.disposed || this.captures.onDownload(event, item, contents)) return;
    const tabId = contents && this.tabs.get(contents);
    if (!tabId || event.defaultPrevented || item.getSavePath()) return;
    let path: string | undefined;
    try {
      this.store.assertCanStart();
      const directory = this.options.directory();
      if (!isAbsolute(directory)) throw new Error('Download directory must be absolute');
      mkdirSync(directory, { recursive: true });
      const filename = downloadFilename(item.getFilename());
      const extension = extname(filename);
      const stem = filename.slice(0, filename.length - extension.length);
      for (let index = 0; index < 10_000; index++) {
        const candidate = join(directory, index ? `${stem} (${index})${extension}` : filename);
        // Electron requires synchronous path selection before will-download returns. No content I/O here.
        if (!existsSync(candidate) && !existsSync(`${candidate}.crdownload`) && this.reserve(candidate)) { path = candidate; break; }
      }
      if (!path) throw new Error('No available download filename');
      const savePath = path;
      item.setSavePath(savePath);
      const id = this.store.start(item, basename(savePath), savePath);
      const control = this.recovery.track(id, savePath, item);
      this.store.active.set(id, control);
      let lastUpdate = 0;
      const updated = (_event: Event, state: string): void => {
        void this.recovery.checkpoint(id).catch(this.onError);
        if (Date.now() - lastUpdate < 250 && state !== 'interrupted') return;
        lastUpdate = Date.now();
        this.store.update(id, control, item.isPaused() || state === 'interrupted' ? 'paused' : 'progressing');
      };
      item.on('updated', updated);
      item.once('done', (_event, state) => {
        item.removeListener('updated', updated);
        this.release(savePath);
        control.getReceivedBytes();
        control.getTotalBytes();
        const checkpoint = this.recovery.checkpoint(id, true);
        const finishing = (async () => {
          let status: DownloadStatus = state;
          if (status === 'completed') {
            try { if (!(await fileStat(savePath))?.isFile()) status = 'interrupted'; }
            catch (error) { status = 'interrupted'; this.onError(error); }
          }
          await checkpoint;
          const finished = await this.recovery.finished(id, status);
          this.store.finish(id, control, finished);
          await this.recovery.offer(id);
          if (status === 'completed') {
            const download = (await this.store.list()).find((entry) => entry.id === id);
            if (download) this.options.onCompleted?.(tabId, download);
          }
        })();
        this.finishing.add(finishing);
        void finishing.finally(() => this.finishing.delete(finishing)).catch(this.onError);
      });
    } catch (error) {
      if (path) this.release(path);
      item.cancel();
      this.onError(error);
    }
  };

  async list(refreshFileState = false): Promise<IabDownload[]> { await this.initialize(); return this.store.list(refreshFileState); }
  async control(command: IabDownloadCommand): Promise<void> {
    await this.initialize();
    if (command.action === 'open-directory') {
      await mkdir(this.options.directory(), { recursive: true });
      const error = await shell.openPath(this.options.directory());
      if (error) throw new Error('Download directory could not be opened');
      return;
    }
    if (command.action === 'remove') return this.store.remove(command.id);
    if (command.action === 'open' || command.action === 'show-in-folder') {
      const path = await this.store.availablePath(command.id);
      if (!path) throw new Error('Downloaded file is missing');
      if (command.action === 'show-in-folder') shell.showItemInFolder(path);
      else {
        const error = await shell.openPath(path);
        if (error) throw new Error('Downloaded file could not be opened');
      }
      return;
    }
    return this.store.control(command.id, command.action);
  }
  async clear(): Promise<void> { await this.initialize(); await this.store.clear(); }
  subscribe(listener: () => void): () => void { return this.store.subscribe(listener); }

  setDownloadBehavior(contents: WebContents, options: IabDownloadCaptureOptions): void { this.captures.setBehavior(contents, options); }
  resetPopup(contents: WebContents): void { this.captures.resetPopup(contents); }
  releaseDownloadCapture(contents: WebContents, owner: string): void { this.captures.release(contents, owner); }
  followDownloadPopup(opener: WebContents, popup: WebContents): void { this.captures.followPopup(opener, popup); }
  reportDownloadSaved(contents: WebContents, owner: string, guid: string, finalPath: string, assertCurrent: () => void | Promise<void>): Promise<void> {
    return this.captures.reportSaved(contents, owner, guid, finalPath, assertCurrent);
  }

  prepareForQuit(): Promise<void> {
    return this.preparingQuit ??= (async () => {
      try {
        await this.store.flushForShutdown();
        await Promise.all([...this.finishing]);
        await this.store.flush();
      } catch (error) {
        this.cancelQuit();
        throw error;
      }
    })();
  }

  cancelQuit(): void {
    this.preparingQuit = undefined;
    this.store.cancelShutdown();
  }

  async flush(): Promise<void> {
    await this.initialize();
    await Promise.all([...this.finishing]);
    await this.store.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.periodicTimer);
    this.session.removeListener('will-download', this.onDownload);
    this.captures.dispose();
    this.recovery.dispose();
    this.store.dispose();
    this.tabs.clear();
    this.reserved.clear();
  }
}
