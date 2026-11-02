import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebContentsView, type BrowserWindow, type WebContents } from 'electron';

import type { IabOverlayCommand, IabOverlayInput, IabOverlayState } from '../../../src/types/desktop/iab';
import type { IabOverlayOptions } from './contracts';

const STATE = 'iab:overlay:state';
const overlays = new WeakMap<WebContents, IabOverlay>();

export function getIabOverlay(contents: WebContents): IabOverlay | undefined { return overlays.get(contents); }

export function iabActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b[A-Za-z]:[\\/][^\r\n'"<>]*/g, '[…]')
    .replace(/\/(?:Users|home|tmp|var|private|Volumes)\/[^\s'"<>]*/g, '[…]')
    .replace(/(Bearer\s+)[\w.+/-]+/gi, '$1[…]')
    .replace(/([?&](?:[^=&\s]*(?:token|secret|password|authorization|credential|signature|api[-_]?key)[^=&\s]*)=)[^&\s]*/gi, '$1[…]')
    .slice(0, 600);
}

/** One cached, transparent transient view. Ordinary dismissal never destroys its renderer. */
export class IabOverlay {
  readonly entryUrl = pathToFileURL(join(__dirname, 'iab/overlay/index.html')).href;
  private current: IabOverlayState = null;
  private view?: WebContentsView;
  private ready?: Promise<void>;
  private parent?: BrowserWindow;
  private removeParentListeners?: () => void;
  private attached = false;
  private disposed = false;
  private sessionId = 0;
  private toastTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: IabOverlayOptions) {}

  get state(): IabOverlayState { return this.current; }

  async show(input: IabOverlayInput): Promise<number> {
    if (this.disposed) throw new Error('Browser tools overlay was released');
    const suggestions = input.kind === 'suggestions';
    if (suggestions && this.current && !['suggestions', 'toast'].includes(this.current.kind)) return this.sessionId;
    if (this.current && (!suggestions || this.current.kind === 'toast')) this.dismiss();
    const parent = this.options.window();
    if (!parent || parent.isDestroyed()) throw new Error('Browser window is unavailable');
    if (this.current && this.parent !== parent) this.dismiss();
    this.bindParent(parent);
    const sessionId = ++this.sessionId;
    this.current = { ...input, sessionId };
    const ready = this.ensureView();
    const view = this.view;
    try { await ready; }
    catch (error) {
      if (this.current?.sessionId !== sessionId || this.view !== view) return sessionId;
      this.dismiss(); this.closeView(); throw error;
    }
    if (this.disposed || parent.isDestroyed() || this.view !== view || this.current?.sessionId !== sessionId) return sessionId;
    this.view!.webContents.setZoomFactor(1);
    if (!this.positionView()) { this.dismiss(); return sessionId; }
    if (!this.attached) parent.contentView.addChildView(this.view!);
    this.attached = true;
    this.view!.setVisible(true);
    this.publish();
    if (input.kind === 'menu' || input.kind === 'downloads') this.view!.webContents.focus();
    if (input.kind === 'toast') {
      this.toastTimer = setTimeout(() => {
        if (this.current?.sessionId === sessionId) this.dismiss();
      }, 2_500);
      this.toastTimer.unref();
    }
    return sessionId;
  }

  update(input: IabOverlayInput, sessionId: number): void {
    if (this.current?.sessionId !== sessionId || this.current.kind !== input.kind) return;
    this.current = { ...input, sessionId };
    if (!this.positionView()) { this.dismiss(); return; }
    this.publish();
  }

  private positionView(): boolean {
    const state = this.current;
    const parent = this.parent;
    if (!state || !parent || parent.isDestroyed() || !this.view) return false;
    const [width, height] = parent.getContentSize();
    const { anchor } = state;
    let bounds = { x: 0, y: 0, width, height };
    if (state.kind === 'toast' || state.kind === 'download') {
      const left = Math.max(0, Math.min(anchor.x, width));
      const right = Math.max(left, Math.min(anchor.x + Math.max(0, anchor.width), width));
      const viewWidth = Math.min(400, right - left);
      if (state.kind === 'toast') {
        const viewHeight = Math.min(88, height);
        if (viewWidth <= 0 || viewHeight <= 0) return false;
        bounds = { x: Math.round(left + (right - left - viewWidth) / 2),
          y: Math.max(0, Math.min(Math.round(anchor.y + 12), height - viewHeight)),
          width: Math.round(viewWidth), height: viewHeight };
      } else {
        const top = Math.max(0, Math.min(anchor.y, height));
        const viewHeight = Math.min(192, Math.max(0, height - top));
        if (viewWidth < 240 || viewHeight < 140) return false;
        bounds = { x: Math.round(right - viewWidth), y: Math.round(top),
          width: Math.round(viewWidth), height: Math.round(viewHeight) };
      }
    } else if (state.kind === 'suggestions') {
      if (!state.entries.length) return false;
      const viewWidth = Math.min(Math.round(anchor.width) + 8, width - 16);
      const x = Math.max(8, Math.min(Math.round(anchor.x) - 4, width - viewWidth - 8));
      const y = Math.min(Math.round(anchor.y + anchor.height + 4), height - 16);
      const viewHeight = Math.min(20 + 48 * state.entries.length, height - y - 8);
      if (viewWidth < 40 || viewHeight < 40) return false;
      bounds = { x, y, width: viewWidth, height: viewHeight };
    }
    this.view.setBounds(bounds);
    return true;
  }

  async execute(command: IabOverlayCommand): Promise<void> {
    const state = this.current;
    if (!command || typeof command !== 'object' || !state || !Number.isSafeInteger(command.sessionId) || command.sessionId !== state.sessionId) {
      throw new Error('Browser tools overlay is no longer available');
    }
    if (command.action === 'dismiss') { this.dismiss(); return; }
    if (command.action === 'menu') {
      if (state.kind !== 'menu' || !['find', 'history', 'downloads', 'open-external', 'screenshot',
        'clear-cache', 'clear-site-data', 'zoom-in', 'zoom-out', 'zoom-reset'].includes(command.command)) {
        throw new Error('Invalid browser tools menu action');
      }
    } else if (command.action === 'download') {
      if ((state.kind !== 'download' && state.kind !== 'downloads') || !command.command ||
        !['open', 'show-in-folder', 'cancel', 'pause', 'resume', 'remove', 'open-directory'].includes(command.command.action)) {
        throw new Error('Invalid browser download action');
      }
      const action = command.command;
      if (state.kind === 'download' && (action.action === 'open-directory' ||
        !['open', 'show-in-folder'].includes(action.action) || action.id !== state.download.id)) {
        throw new Error('Invalid completed download action');
      }
      if (action.action !== 'open-directory' && (typeof action.id !== 'string' ||
        (state.kind === 'downloads' && !state.entries.some((entry) => entry.id === action.id)))) {
        throw new Error('Download entry is no longer available');
      }
    } else if (command.action === 'refresh-downloads') {
      if (state.kind !== 'downloads') throw new Error('Downloads panel is no longer available');
    } else if (command.action === 'select-suggestion' || command.action === 'remove-suggestion') {
      if (state.kind !== 'suggestions' || typeof command.id !== 'string' || !state.entries.some((entry) => entry.id === command.id)) {
        throw new Error('History suggestion is no longer available');
      }
    } else throw new Error('Invalid browser tools overlay action');
    await this.options.onCommand(command, state);
  }

  dismiss(): void {
    if (this.current === null && !this.attached) return;
    clearTimeout(this.toastTimer);
    this.toastTimer = undefined;
    const shouldRestoreFocus = this.current?.kind === 'menu' || this.current?.kind === 'downloads';
    this.current = null;
    if (this.attached && this.parent && !this.parent.isDestroyed() && this.view) {
      this.view.setVisible(false);
      this.parent.contentView.removeChildView(this.view);
      if (shouldRestoreFocus && this.parent.isFocused() && !this.parent.webContents.isDestroyed()) this.parent.webContents.focus();
    }
    this.attached = false;
    this.publish();
  }

  private publish(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send(STATE, this.current);
    this.options.emit({ type: 'overlay-state', state: this.current });
  }

  private bindParent(parent: BrowserWindow): void {
    if (this.parent === parent) return;
    this.unbindParent();
    this.closeView();
    this.parent = parent;
    const contents = parent.webContents;
    parent.on('resize', this.onDismiss);
    parent.on('hide', this.onDismiss);
    parent.on('blur', this.onDismiss);
    parent.once('closed', this.onClosed);
    contents.on('render-process-gone', this.onRendererGone);
    this.removeParentListeners = () => {
      parent.removeListener('resize', this.onDismiss);
      parent.removeListener('hide', this.onDismiss);
      parent.removeListener('blur', this.onDismiss);
      parent.removeListener('closed', this.onClosed);
      contents.removeListener('render-process-gone', this.onRendererGone);
    };
  }

  private readonly onDismiss = (): void => { this.dismiss(); };
  private readonly onClosed = (): void => { this.dispose(); };
  private readonly onRendererGone = (): void => { this.dismiss(); this.closeView(); };

  private unbindParent(): void {
    this.removeParentListeners?.();
    this.removeParentListeners = undefined;
    this.parent = undefined;
  }

  private ensureView(): Promise<void> {
    if (this.ready) return this.ready;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.ready = this.view.webContents.loadURL(this.entryUrl).then(() => {});
      return this.ready;
    }
    const view = new WebContentsView({ webPreferences: {
      preload: join(__dirname, '../preload/iab-overlay.js'),
      partition: 'iab-tools-overlay',
      contextIsolation: true, sandbox: true, nodeIntegration: false, focusOnNavigation: false,
    } });
    this.view = view;
    view.setBackgroundColor('#00000000');
    const contents = view.webContents;
    overlays.set(contents, this);
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('render-process-gone', () => { this.dismiss(); this.closeView(); });
    this.ready = contents.loadURL(this.entryUrl).then(() => {});
    return this.ready;
  }

  private closeView(): void {
    const view = this.view;
    this.view = undefined;
    this.ready = undefined;
    if (!view) return;
    if (this.attached && this.parent && !this.parent.isDestroyed()) this.parent.contentView.removeChildView(view);
    this.attached = false;
    overlays.delete(view.webContents);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dismiss();
    this.closeView();
    this.unbindParent();
  }
}
