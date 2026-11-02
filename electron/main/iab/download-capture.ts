import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DownloadItem, Event, WebContents } from 'electron';

import type { IabDownloadCaptureOptions } from './contracts';
import { DownloadStore, type DownloadControl } from './download-store';
import { pathKey } from './download-recovery';

type CapturedDownload = {
  id: string; item: DownloadControl; path: string;
  state: 'active' | 'awaiting-path' | 'saved' | 'failed';
  pathTimer?: ReturnType<typeof setTimeout>;
};
type Capture = IabDownloadCaptureOptions & {
  directory: string; completed: boolean;
  children: Set<WebContents>; downloads: Map<string, CapturedDownload>;
  active: Map<DownloadItem, { contents: WebContents; cancel(): void }>;
};

export function downloadFilename(value: string): string {
  let filename = value.replace(/\\/g, '/').split('/').at(-1)!.replace(/\p{Cc}/gu, '');
  if (process.platform === 'win32') {
    filename = filename.replace(/[<>:"|?*]/g, '_').replace(/[ .]+$/u, '');
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(filename.split('.')[0].trimEnd())) filename = `_${filename}`;
  }
  return filename && filename !== '.' && filename !== '..' ? filename : 'download';
}

export class DownloadCapture {
  private readonly captures = new Map<WebContents, Capture>();
  private readonly popups = new Map<WebContents, { capture: Capture; dispose(): void }>();
  private readonly fences = new Map<WebContents, () => void>();
  private readonly reserved = new Set<string>();
  private disposed = false;

  constructor(private readonly store: DownloadStore) {}

  setBehavior(contents: WebContents, options: IabDownloadCaptureOptions): void {
    if (this.disposed) throw new Error('IAB download capture was disposed');
    if (!['allow', 'allowAndName', 'deny'].includes(options.behavior)) throw new Error('Invalid IAB download behavior');
    if (options.behavior !== 'deny' && (typeof options.downloadPath !== 'string' || !isAbsolute(options.downloadPath))) {
      throw new Error('IAB downloadPath must be an absolute directory');
    }
    const previous = this.captures.get(contents);
    if (this.popups.has(contents) || (previous && (previous.owner !== options.owner || previous.active.size > 0))) {
      throw new Error('IAB download capture is already owned by an active lease');
    }
    const directory = options.downloadPath === undefined ? '' : resolve(options.downloadPath);
    if (options.behavior !== 'deny') mkdirSync(directory, { recursive: true });
    if (previous) this.release(contents, previous.owner);
    this.captures.set(contents, { ...options, directory, completed: false,
      children: new Set(), downloads: new Map(), active: new Map() });
    this.fences.get(contents)?.();
  }

  followPopup(opener: WebContents, popup: WebContents): void {
    if (this.disposed || opener === popup || opener.session !== popup.session) return;
    if (this.fences.has(opener)) { this.fence(popup); return; }
    const capture = this.captures.get(opener) ?? this.popups.get(opener)?.capture;
    if (!capture || capture.completed || this.captures.has(popup) || this.popups.has(popup)) return;
    const mouse = (_event: unknown, input: { type: string }): void => { if (input.type === 'mouseDown') dispose(); };
    const keyboard = (_event: unknown, input: { type: string }): void => { if (input.type === 'keyDown') dispose(); };
    const destroyed = (): void => {
      dispose();
      for (const active of [...capture.active.values()]) if (active.contents === popup) active.cancel();
    };
    const dispose = (): void => {
      popup.removeListener('destroyed', destroyed);
      popup.removeListener('before-mouse-event', mouse);
      popup.removeListener('before-input-event', keyboard);
      capture.children.delete(popup);
      this.popups.delete(popup);
    };
    capture.children.add(popup);
    this.popups.set(popup, { capture, dispose });
    popup.once('destroyed', destroyed);
    popup.on('before-mouse-event', mouse);
    popup.on('before-input-event', keyboard);
  }

  resetPopup(contents: WebContents): void {
    this.popups.get(contents)?.dispose();
    this.fences.get(contents)?.();
  }

  release(contents: WebContents, owner: string): void {
    const capture = this.captures.get(contents);
    if (!capture || capture.owner !== owner) return;
    this.captures.delete(contents);
    const needsFence = !capture.completed && capture.behavior !== 'deny';
    if (needsFence) this.fence(contents);
    for (const child of [...capture.children]) {
      this.popups.get(child)?.dispose();
      if (needsFence) this.fence(child);
    }
    for (const active of [...capture.active.values()]) active.cancel();
    for (const download of capture.downloads.values()) this.failAwaitingPath(download);
  }

  private fence(contents: WebContents): void {
    if (this.fences.has(contents) || contents.isDestroyed()) return;
    const mouse = (_event: unknown, input: { type: string }): void => { if (input.type === 'mouseDown') dispose(); };
    const keyboard = (_event: unknown, input: { type: string }): void => { if (input.type === 'keyDown') dispose(); };
    const dispose = (): void => {
      clearTimeout(timer);
      contents.removeListener('before-mouse-event', mouse);
      contents.removeListener('before-input-event', keyboard);
      contents.removeListener('destroyed', dispose);
      this.fences.delete(contents);
    };
    const timer = setTimeout(dispose, 30_000);
    timer.unref();
    this.fences.set(contents, dispose);
    contents.on('before-mouse-event', mouse);
    contents.on('before-input-event', keyboard);
    contents.once('destroyed', dispose);
  }

  private failAwaitingPath(download: CapturedDownload): void {
    if (download.state !== 'awaiting-path') return;
    clearTimeout(download.pathTimer);
    download.state = 'failed';
    this.store.finish(download.id, download.item, 'interrupted');
  }

  onDownload(event: Event, item: DownloadItem, contents: WebContents | undefined): boolean {
    if (this.disposed || !contents || event.defaultPrevented) return false;
    if (this.fences.has(contents) && !item.getSavePath()) { item.cancel(); return true; }
    const capture = this.captures.get(contents) ?? this.popups.get(contents)?.capture;
    if (!capture || item.getSavePath()) return false;
    const guid = randomUUID();
    let filename = 'download';
    let url = '';
    let received = 0;
    let total = 0;
    let begun = false;
    const reportError = (error: unknown): void => { try { capture.onError(error instanceof Error ? error : new Error(String(error))); } catch { /* Observer cannot change download ownership. */ } };
    const safely = (action: () => void): void => { try { action(); } catch (error) { reportError(error); } };
    const sample = (): void => { received = item.getReceivedBytes(); total = item.getTotalBytes(); };
    const begin = (): void => {
      if (begun) return;
      begun = true;
      capture.emit({ type: 'will-begin', guid, url, suggestedFilename: filename });
    };
    const progress = (state: 'inProgress' | 'completed' | 'canceled'): void => {
      capture.emit({ type: 'progress', guid, state, receivedBytes: received, totalBytes: total });
    };
    let path: string | undefined;
    let record: CapturedDownload | undefined;
    try {
      filename = downloadFilename(item.getFilename());
      url = item.getURL();
      sample();
      if (capture.behavior === 'deny') { safely(begin); safely(() => item.cancel()); safely(() => progress('canceled')); return true; }
      this.store.assertCanStart();
      if (capture.behavior === 'allow') {
        for (let index = 0; index < 10_000; index++) {
          const candidate = join(capture.directory, index ? `${index}-${filename}` : filename);
          // setSavePath must run synchronously in Electron's will-download callback.
          if (!this.reserved.has(pathKey(candidate)) && !existsSync(candidate) && !existsSync(`${candidate}.crdownload`)) { path = candidate; break; }
        }
        if (!path) throw new Error('No available download filename');
      } else path = join(capture.directory, guid);
      const savePath = path;
      const key = pathKey(savePath);
      this.reserved.add(key);
      item.setSavePath(savePath);
      let lastUpdate = 0;
      const control: DownloadControl = {
        getReceivedBytes: () => received,
        getTotalBytes: () => total,
        pause: () => { if (download.state !== 'active') throw new Error('Download is awaiting final path confirmation'); item.pause(); },
        resume: () => { if (download.state !== 'active') throw new Error('Download is awaiting final path confirmation'); item.resume(); },
        pauseForShutdown: () => download.state === 'active' && (item.pause(), true),
        cancel: () => { if (download.state === 'awaiting-path') this.failAwaitingPath(download); else cancel(); },
      };
      const download: CapturedDownload = { id: this.store.start(control, filename, savePath), item: control, path: savePath, state: 'active' };
      record = download;
      capture.downloads.set(guid, download);
      const updated = (_event: Event, state: string): void => {
        if (!capture.active.has(item)) return;
        safely(sample);
        safely(() => progress('inProgress'));
        if (Date.now() - lastUpdate < 250 && state !== 'interrupted') return;
        lastUpdate = Date.now();
        safely(() => this.store.update(download.id, control, item.isPaused() || state === 'interrupted' ? 'paused' : 'progressing'));
      };
      const finish = (state: string): void => {
        if (state === 'completed') {
          download.state = 'awaiting-path';
          download.pathTimer = setTimeout(() => {
            if (download.state !== 'awaiting-path') return;
            safely(() => this.failAwaitingPath(download));
            reportError(new Error('IAB download final path confirmation timed out'));
          }, Math.max(0, (capture.requestDeadlineAt ?? 0) - Date.now()) + 15_000);
          download.pathTimer.unref();
          this.store.update(download.id, control, 'progressing');
        } else {
          download.state = 'failed';
          this.store.finish(download.id, control, state === 'cancelled' ? 'cancelled' : 'interrupted');
        }
      };
      const cleanup = (): void => {
        capture.active.delete(item);
        this.reserved.delete(key);
        item.removeListener('updated', updated);
        item.removeListener('done', done);
      };
      const done = (_event: Event, state: string): void => {
        if (!capture.active.has(item)) return;
        cleanup();
        safely(sample);
        if (state === 'completed') capture.completed = true;
        safely(() => finish(state));
        safely(() => progress(state === 'completed' ? 'completed' : 'canceled'));
      };
      const cancel = (): void => {
        if (!capture.active.has(item)) return;
        try { item.cancel(); } catch (error) { reportError(error); }
        finally {
          if (capture.active.has(item)) { cleanup(); safely(() => finish('cancelled')); safely(() => progress('canceled')); }
        }
      };
      capture.active.set(item, { contents, cancel });
      item.on('updated', updated);
      item.once('done', done);
      begin();
      return true;
    } catch (error) {
      const active = capture.active.get(item);
      if (active) active.cancel();
      if (record) {
        clearTimeout(record.pathTimer);
        record.state = 'failed';
        safely(() => this.store.finish(record!.id, record!.item, 'interrupted'));
      }
      if (path) this.reserved.delete(pathKey(path));
      reportError(error);
      safely(begin);
      safely(() => item.cancel());
      safely(() => progress('canceled'));
      return true;
    }
  }

  async reportSaved(contents: WebContents, owner: string, guid: string, finalPath: string, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const capture = this.captures.get(contents);
    const download = capture?.downloads.get(guid);
    if (!capture || capture.owner !== owner || !download || download.state === 'active' || download.state === 'failed') {
      throw new Error('IAB download is not awaiting a final path for this lease');
    }
    if (!isAbsolute(finalPath) || pathKey(dirname(finalPath)) !== pathKey(capture.directory)) {
      throw new Error('IAB download final path must stay in its capture directory');
    }
    const path = join(resolve(capture.directory), basename(finalPath));
    if (download.state === 'saved') {
      if (pathKey(download.path) !== pathKey(path)) throw new Error('IAB download was already finalized at another path');
      return;
    }
    const saved = await lstat(path);
    assertCurrent();
    if (this.captures.get(contents) !== capture || download.state !== 'awaiting-path') throw new Error('IAB download capture was released before path confirmation');
    if (!saved.isFile() || saved.size !== download.item.getReceivedBytes()) throw new Error('IAB download final file does not match its completed transfer');
    this.store.finish(download.id, download.item, 'completed', path);
    clearTimeout(download.pathTimer);
    download.path = path;
    download.state = 'saved';
  }

  dispose(): void {
    for (const [contents, capture] of this.captures) this.release(contents, capture.owner);
    for (const popup of [...this.popups.values()]) popup.dispose();
    for (const dispose of [...this.fences.values()]) dispose();
    this.disposed = true;
  }
}
