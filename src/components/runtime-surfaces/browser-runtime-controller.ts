// Browser interaction flow adapted from OpenClaw ui/src/components/browser/.
// SPDX-License-Identifier: MIT. See ../../pages/Chat/tool-renderers/openclaw/{LICENSE,NOTICE}.
import {
  decodeBrowserMutationResult, decodeBrowserOperationFailure, decodeBrowserStartResult, decodeBrowserStatus, decodeBrowserTab, decodeBrowserTabs, isBrowserAction,
  type BrowserAction, type BrowserOperationErrorCode, type BrowserRequestInput,
  type BrowserScreenshot, type BrowserStatus, type BrowserTab,
} from '@/types/openclaw-browser';
import { loadBrowserScreenshot, requestBrowser, type BrowserRequestScope } from './browser-screenshots';

export type BrowserSurfaceTarget = BrowserTab & {
  readonly target: NonNullable<BrowserRequestInput['target']>;
  readonly profile: string;
  readonly node?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
};

export type BrowserRuntimeMessage = 'evaluationDisabled' | 'inputUnsupported' | 'operationUnsupported' | 'queueFull' | 'unknownOutcome' | 'screenshotUnavailable' | 'keyboardScroll' | 'invalidInput';

export type BrowserRuntimeState = {
  readonly tabs: BrowserTab[];
  readonly targetId: string;
  readonly screenshot: BrowserScreenshot | null;
  readonly status: BrowserStatus | null;
  readonly busy: boolean;
  readonly error: BrowserRuntimeMessage | null;
  readonly notice: BrowserRuntimeMessage | null;
};

type BrowserCommand =
  | { kind: 'refresh' }
  | { kind: 'start' }
  | { kind: 'open'; url: string }
  | { kind: 'navigate'; targetId: string; url: string }
  | { kind: 'focus'; targetId: string }
  | { kind: 'close'; targetId: string }
  | { kind: 'act'; action: BrowserAction };

type PendingCommand = { command: BrowserCommand; epoch: number };
const tabId = (tab: BrowserTab) => tab.tabId || tab.targetId;
const clampScroll = (delta: number) => Math.max(-1200, Math.min(1200, Math.round(delta)));
const failureMessage: Record<BrowserOperationErrorCode, BrowserRuntimeMessage> = {
  browser_evaluation_disabled: 'evaluationDisabled',
  browser_input_unsupported: 'inputUnsupported',
  browser_operation_unsupported: 'operationUnsupported',
};

class BrowserOperationError extends Error {
  constructor(readonly code: BrowserOperationErrorCode) { super(code); }
}

/** One live surface owns its timers and ordered input; close retires every continuation. */
export class BrowserRuntimeController {
  private state: BrowserRuntimeState;
  private readonly listeners = new Set<() => void>();
  private readonly scope: BrowserRequestScope;
  private queue: PendingCommand[] = [];
  private live = false;
  private draining = false;
  private epoch = 0;
  private mutation = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private wheelTimer: ReturnType<typeof setTimeout> | undefined;
  private wheel: Extract<BrowserAction, { kind: 'scrollBy' }> | null = null;
  private keyboardScroll = false;
  private readonly captureId = crypto.randomUUID();
  private captureRevision = 0;

  constructor(surface: BrowserSurfaceTarget, private readonly scopeKey: string) {
    this.scope = { target: surface.target, ...(surface.node ? { node: surface.node } : {}), query: { profile: surface.profile } };
    this.state = { tabs: [], targetId: surface.tabId || surface.targetId, screenshot: null, status: null, busy: false, error: null, notice: null };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<BrowserRuntimeState>): void {
    if (!this.live) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  connect(): void { this.live = true; this.refresh(); }
  close(): void {
    this.live = false;
    this.epoch += 1;
    this.queue = [];
    this.clearTimers();
  }

  private clearTimers(): void {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.wheelTimer);
    this.refreshTimer = undefined;
    this.wheelTimer = undefined;
    this.wheel = null;
  }

  private enqueue(command: BrowserCommand, newDocument = false): void {
    if (!this.live) return;
    if (newDocument) {
      this.epoch += 1;
      this.queue = [];
      this.clearTimers();
      this.patch({ screenshot: null });
    } else if (command.kind !== 'refresh') {
      this.flushWheel();
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (command.kind !== 'refresh') {
      this.mutation += 1;
      this.queue = this.queue.filter((pending) => pending.command.kind !== 'refresh');
    }
    const previous = this.queue[this.queue.length - 1]?.command;
    if (previous?.kind === 'act' && command.kind === 'act' && previous.action.targetId === command.action.targetId) {
      if (previous.action.kind === 'insertText' && command.action.kind === 'insertText' && previous.action.text.length + command.action.text.length <= 32_768) {
        previous.action = { ...previous.action, text: previous.action.text + command.action.text };
        return;
      }
      if (previous.action.kind === 'scrollBy' && command.action.kind === 'scrollBy') {
        previous.action = { ...command.action, deltaX: clampScroll(previous.action.deltaX + command.action.deltaX), deltaY: clampScroll(previous.action.deltaY + command.action.deltaY) };
        return;
      }
    }
    if (this.queue.length >= 64) {
      this.patch({ error: 'queueFull' });
      return;
    }
    this.queue.push({ command, epoch: this.epoch });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.patch({ busy: true, error: null });
    try {
      while (this.live && this.queue.length) {
        const pending = this.queue.shift()!;
        const current = () => this.live && this.epoch === pending.epoch;
        if (!current()) continue;
        try {
          await this.perform(pending.command, current);
        } catch (error) {
          if (!current()) continue;
          // An unknown outcome is never replayed, nor followed by stale queued input.
          this.queue = [];
          this.clearTimers();
          this.patch({ error: error instanceof BrowserOperationError ? failureMessage[error.code] : 'unknownOutcome' });
        }
      }
    } finally {
      this.draining = false;
      this.patch({ busy: false });
    }
  }

  private async request(method: BrowserRequestInput['method'], path: string, body: BrowserRequestInput['body'], current: () => boolean): Promise<unknown> {
    const result = await requestBrowser(this.scope, method, path, body, current);
    const failure = decodeBrowserOperationFailure(result);
    if (failure) throw new BrowserOperationError(failure.errorCode);
    if (method !== 'GET' && !(path === '/start' ? decodeBrowserStartResult(result) : path === '/tabs/open' ? decodeBrowserTab(result) : decodeBrowserMutationResult(result))) {
      throw new Error('Invalid browser operation result');
    }
    return result;
  }

  private scheduleRefresh(current: () => boolean): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (current()) this.enqueue({ kind: 'refresh' });
    }, 350);
  }

  private async refreshAll(current: () => boolean): Promise<void> {
    const mutation = this.mutation;
    const captureCurrent = () => current() && mutation === this.mutation;
    const status = decodeBrowserStatus(await this.request('GET', '/', undefined, captureCurrent));
    if (!captureCurrent()) return;
    if (!status) throw new Error('Invalid browser status');
    this.patch({ status });
    const result = await this.request('GET', '/tabs', undefined, captureCurrent);
    if (!captureCurrent()) return;
    const tabs = decodeBrowserTabs(result);
    if (!tabs) throw new Error('Invalid browser tabs');
    const active = tabs.find((tab) => tabId(tab) === this.state.targetId || tab.targetId === this.state.targetId)
      ?? tabs.find((tab) => tab.active) ?? tabs[0];
    const targetId = active ? tabId(active) : '';
    this.patch({ tabs, targetId, ...(targetId !== this.state.targetId || !status.running ? { screenshot: null } : {}) });
    if (!active || !status.running || !captureCurrent()) return;
    const image = await loadBrowserScreenshot(this.scope, this.scopeKey, targetId, `${this.captureId}:${++this.captureRevision}`, captureCurrent);
    if (!captureCurrent()) return;
    this.patch(image ? { screenshot: image, error: null } : { screenshot: null, error: 'screenshotUnavailable' });
  }

  private async perform(command: BrowserCommand, current: () => boolean): Promise<void> {
    switch (command.kind) {
      case 'refresh': await this.refreshAll(current); return;
      case 'start': await this.request('POST', '/start', {}, current); break;
      case 'open': {
        const result = await this.request('POST', '/tabs/open', { url: command.url }, current);
        if (current() && result && typeof result === 'object') {
          const record = result as Record<string, unknown>;
          const id = typeof record.tabId === 'string' ? record.tabId : typeof record.targetId === 'string' ? record.targetId : '';
          if (id) this.patch({ targetId: id });
        }
        break;
      }
      case 'navigate': {
        const result = await this.request('POST', '/navigate', { targetId: command.targetId, url: command.url }, current);
        if (current() && result && typeof result === 'object') {
          const record = result as Record<string, unknown>;
          const alias = this.state.tabs.find((tab) => tabId(tab) === command.targetId)?.tabId;
          const id = alias || (typeof record.tabId === 'string' ? record.tabId : typeof record.targetId === 'string' ? record.targetId : command.targetId);
          this.patch({ targetId: id });
        }
        break;
      }
      case 'focus': await this.request('POST', '/tabs/focus', { targetId: command.targetId }, current); break;
      case 'close':
        await this.request('DELETE', `/tabs/${encodeURIComponent(command.targetId)}`, undefined, current);
        if (current()) this.patch({ tabs: this.state.tabs.filter((tab) => tabId(tab) !== command.targetId && tab.targetId !== command.targetId) });
        break;
      case 'act': {
        const action = command.action;
        if (action.kind !== 'scrollBy') {
          await this.request('POST', '/act', action, current);
          break;
        }
        try {
          if (this.keyboardScroll) throw new BrowserOperationError('browser_evaluation_disabled');
          await this.request('POST', '/act', action, current);
        } catch (error) {
          if (!(error instanceof BrowserOperationError) || error.code !== 'browser_evaluation_disabled' || !current() || action.deltaY === 0) throw error;
          this.keyboardScroll = true;
          this.patch({ notice: 'keyboardScroll' });
          await this.request('POST', '/act', { kind: 'press', targetId: action.targetId, key: action.deltaY > 0 ? 'PageDown' : 'PageUp' }, current);
        }
        break;
      }
    }
    if (current()) this.scheduleRefresh(current);
  }

  refresh(): void {
    this.keyboardScroll = false;
    this.patch({ notice: null });
    this.enqueue({ kind: 'refresh' });
  }
  start(): void { this.enqueue({ kind: 'start' }, true); }
  open(url: string): void { this.enqueue({ kind: 'open', url }, true); }
  navigate(url: string): void {
    if (this.state.targetId) this.enqueue({ kind: 'navigate', targetId: this.state.targetId, url }, true);
  }
  focus(targetId: string): void {
    this.enqueue({ kind: 'focus', targetId }, true);
    this.patch({ targetId });
  }
  closeTab(targetId: string): void {
    this.enqueue({ kind: 'close', targetId }, targetId === this.state.targetId);
  }
  act(action: BrowserAction): void {
    if (!isBrowserAction(action)) { this.patch({ error: 'invalidInput' }); return; }
    this.enqueue({ kind: 'act', action }, action.kind === 'history' || action.kind === 'reload');
  }
  text(text: string): void {
    if (text && this.state.targetId) this.act({ kind: 'insertText', targetId: this.state.targetId, text });
  }
  scroll(deltaX: number, deltaY: number, point?: { x: number; y: number }): void {
    if (!this.live || !this.state.targetId || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.wheel = {
      kind: 'scrollBy', targetId: this.state.targetId,
      deltaX: clampScroll((this.wheel?.deltaX ?? 0) + deltaX), deltaY: clampScroll((this.wheel?.deltaY ?? 0) + deltaY), ...point,
    };
    if (this.wheelTimer) return;
    this.wheelTimer = setTimeout(() => this.flushWheel(), 150);
  }
  private flushWheel(): void {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = undefined;
    const wheel = this.wheel;
    this.wheel = null;
    if (wheel && (wheel.deltaX || wheel.deltaY)) this.act(wheel);
  }
}

const FORWARDED_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function browserKeyChord(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'isComposing' | 'getModifierState'>): string | null {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.getModifierState('AltGraph')) return null;
  if (event.key.length !== 1 && !FORWARDED_KEYS.has(event.key)) return null;
  if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) return null;
  const key = /^[A-Z]$/u.test(event.key) ? event.key.toLowerCase() : event.key === ' ' ? 'Space' : event.key;
  return [event.ctrlKey && 'Control', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

export function browserRemotePoint(bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, event: { clientX: number; clientY: number }, viewport: BrowserScreenshot['viewport']): { x: number; y: number } | null {
  if (!viewport || bounds.width <= 0 || bounds.height <= 0 || event.clientX < bounds.left || event.clientY < bounds.top || event.clientX > bounds.left + bounds.width || event.clientY > bounds.top + bounds.height) return null;
  return {
    x: Math.min(viewport.width - 1, Math.max(0, Math.round((event.clientX - bounds.left) / bounds.width * viewport.width))),
    y: Math.min(viewport.height - 1, Math.max(0, Math.round((event.clientY - bounds.top) / bounds.height * viewport.height))),
  };
}
