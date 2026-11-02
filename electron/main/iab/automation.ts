import type { AutomationContext, AutomationServices } from './automation-port';
import type { BrowserActionParams, BrowserActRequest } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabCdpLease } from './contracts';
import type { IabJsonObject, IabJsonValue } from '../../../src/types/desktop/iab';
import { iabError } from './error';
import { IabAutomationPage, type Operation } from './automation-page';
import { performAct, scrollPage } from './automation-input';
import { IabAutomationUtilities } from './automation-utility';
import { storageOperation } from './automation-storage';
import { armDownload } from './automation-download';
import { clickPoint } from './automation-input';
import { cleanupEmulation, resetEmulation } from './automation-emulation';

type PageState = { principalId: string; lease: IabCdpLease; page: IabAutomationPage; utilities: IabAutomationUtilities; ready: boolean; epoch: number };

/** Automation state and computation live exclusively in the IAB worker. */
export class IabAutomation {
  private readonly pages = new Map<string, Map<string, PageState>>();
  private readonly retainedTabs = new Set<string>();
  private readonly downloadingTabs = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly services: AutomationServices) {
    this.unsubscribe = services.onTabsChanged((tabs) => {
      const owners = new Map(tabs.map((tab) => [tab.id, tab.ownerId]));
      for (const tabId of this.retainedTabs) if (!owners.has(tabId)) this.retainedTabs.delete(tabId);
      for (const [tabId, pages] of this.pages) for (const state of pages.values()) {
        if (owners.get(tabId) !== state.lease.ownerId) this.disposePage(state);
      }
    });
  }

  async handleRequest(params: BrowserActionParams, context: AutomationContext, signal: AbortSignal): Promise<IabJsonValue> {
    if (this.disposed) throw iabError('IAB_AUTOMATION_CLOSED', 'IAB automation is closed');
    if (!context.principalId || !context.sessionKey) throw iabError('IAB_CONTEXT_INVALID', 'Verified browser invocation context is required');
    signal.throwIfAborted();
    context.assertCurrent();
    const services = this.services;
    switch (params.action) {
      case 'start': return { ok: true, profile: 'iab' };
      case 'status': return { enabled: true, running: true, cdpReady: true, pageReady: true, headless: false, profile: 'iab', driver: 'electron', transport: 'cdp' };
      case 'profiles': return { profiles: [{ name: 'iab', running: true, isDefault: true, tabCount: (await services.tabs(context)).tabs.length }] };
      case 'tabs': {
        const { tabs, activeTabId } = await services.tabs(context);
        return { tabs: tabs.map((tab) => ({ targetId: tab.id, tabId: tab.id, title: tab.title, url: tab.url, active: activeTabId === tab.id })) };
      }
      case 'open': {
        const url = validateUrl(params.url ?? 'about:blank');
        context.assertCurrent();
        const tabId = await services.open(url, context);
        if (params.retain) this.retainedTabs.add(tabId);
        const unlock = await this.lockTab(tabId, signal);
        try {
          await this.getPage(tabId, context, signal);
          signal.throwIfAborted(); context.assertCurrent();
          await services.checkTarget(tabId, context);
          return { targetId: tabId, tabId, url };
        } finally { try { await services.drain(context); } finally { unlock(); } }
      }
      case 'stop':
      case 'closeagenttabs':
      case 'close_agent_tabs': {
        let closed = 0;
        for (const tab of (await services.tabs(context)).tabs) if (tab.createdBy === context.principalId && !this.retainedTabs.has(tab.id)) { context.assertCurrent(); await this.closeTab(tab.id, context); closed++; }
        return { ok: true, closed };
      }
    }
    const tabId = ('targetId' in params ? params.targetId : undefined) ?? (params.action === 'act' || params.action === 'utility' ? params.request?.targetId : undefined);
    if (!tabId) throw iabError('IAB_TARGET_REQUIRED', 'A targetId from browser tabs/open is required');
    await services.checkTarget(tabId, context);
    if (params.action === 'close' || (params.action === 'act' && params.request?.kind === 'close')) {
      context.assertCurrent();
      await this.closeTab(tabId, context);
      return { ok: true, targetId: tabId, closed: true };
    }
    if (params.action === 'focus') {
      context.assertCurrent();
      await services.show(tabId, context);
      return { ok: true, targetId: tabId };
    }
    const timeoutMs = ('timeoutMs' in params ? params.timeoutMs : undefined) ?? (params.action === 'act' || params.action === 'utility' ? params.request?.timeoutMs : undefined) ?? (params.action === 'utility' && params.request?.kind === 'download' ? 60_000 : 30_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw iabError('IAB_TIMEOUT_INVALID', 'Browser timeout must be between 1 and 300000ms');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason ?? iabError('IAB_ABORTED', 'Browser operation was cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const operation: Operation = { signal: controller.signal, deadline: Date.now() + timeoutMs, assertCurrent: context.assertCurrent, tasks: new Set(), failures: [] };
    const unbindOperation = services.bindOperation(context, operation.signal);
    const timer = setTimeout(() => controller.abort(iabError('IAB_TIMEOUT', `Browser operation timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    if (params.action === 'act') operation.onActionPerformed = () => clearTimeout(timer);
    let state: PageState | undefined;
    let unlock: (() => void) | undefined;
    let acquired = false;
    let cancelled = false;
    let released = false;
    let download = false;
    let acquiredEpoch = -1;
    let response!: IabJsonObject;
    const failures: unknown[] = [];
    const cancel = () => { if (acquired && !cancelled) { cancelled = true; state!.lease.cancel(operation.signal); } };
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      const queuedState = this.pages.get(tabId)?.get(context.principalId);
      const queuedEpoch = queuedState?.epoch;
      unlock = await this.lockTab(tabId, operation.signal);
      if (queuedState && queuedState.epoch !== queuedEpoch) throw iabError('IAB_QUEUED_EPOCH_CHANGED', 'A preceding operation invalidated this browser epoch; queued input was not dispatched');
      state = await this.getPage(tabId, context, operation.signal);
      acquired = true;
      acquiredEpoch = state.epoch;
      operation.signal.throwIfAborted();
      context.assertCurrent();
      await services.checkTarget(tabId, context);
      operation.assertCurrent = () => {
        context.assertCurrent();
        if (state!.epoch !== acquiredEpoch) throw iabError('IAB_OPERATION_EPOCH_CHANGED', 'Browser physical epoch changed; this operation cannot dispatch more commands');
      };
      state.page.operation = operation;
      if (!state.ready) { await state.page.initialize(operation); await state.utilities.initialize(operation); state.ready = true; }
      let result: IabJsonObject;
      if (params.action === 'utility' && params.request?.kind === 'download') {
        if (this.downloadingTabs.has(tabId)) throw iabError('IAB_DOWNLOAD_CAPTURE_BUSY', 'A download capture is already active for this tab');
        this.downloadingTabs.add(tabId);
        download = true;
        const captureContext = { ...context, assertCurrent: operation.assertCurrent };
        const capture = await armDownload(state.page, params.request, captureContext, state.lease.id, operation);
        let triggerPerformed = false;
        if (params.request.trigger) {
          try {
            const trigger = params.request.trigger;
            if (trigger.kind !== 'click' && trigger.kind !== 'clickCoords') throw iabError('IAB_DOWNLOAD_TRIGGER_INVALID', 'Download trigger must be click or clickCoords');
            if (trigger.kind === 'click' && !trigger.ref?.trim() && !(Number.isSafeInteger(trigger.backendNodeId) && trigger.backendNodeId! > 0)) throw iabError('IAB_DOWNLOAD_TRIGGER_INVALID', 'Download click trigger requires a ref or backendNodeId');
            if (trigger.targetId && trigger.targetId !== tabId) throw iabError('IAB_TARGET_MISMATCH', 'Download trigger must use the captured tab');
            const outcome = await performAct(state.page, trigger, operation);
            if (outcome.actionPerformed === false || outcome.ok === false) throw iabError('IAB_DOWNLOAD_TRIGGER_NOT_PERFORMED', JSON.stringify(outcome));
            triggerPerformed = true;
          } catch (error) { capture.cancel(error); }
        } else { unlock!(); released = true; }
        result = { ...await capture.completion, ...(params.request.trigger ? { triggerPerformed } : {}) };
      } else result = await this.execute(params, { ...context, assertCurrent: operation.assertCurrent }, tabId, state, operation);
      operation.signal.throwIfAborted();
      context.assertCurrent();
      await services.checkTarget(tabId, context);
      response = { targetId: tabId, ...result };
    } catch (error) {
      failures.push(error);
      if (state && acquired) state.ready = false;
    }
    try {
      if (state?.page.operation === operation) state.page.operation = undefined;
      try { if (state && acquired && !released && state.epoch === acquiredEpoch && !operation.signal.aborted) await state.page.releaseObjects({ ...operation, deadline: Math.max(operation.deadline, Date.now() + 10_000) }); }
      catch (error) { failures.push(error); }
      try {
        if (state?.page.operation === operation) state.page.operation = undefined;
        do {
          if (operation.tasks?.size) await Promise.allSettled([...operation.tasks]);
          await services.drain(context);
        } while (operation.tasks?.size);
        failures.push(...operation.failures);
      } catch (error) { failures.push(error); }
      if (!failures.length) {
        try { operation.signal.throwIfAborted(); operation.assertCurrent?.(); }
        catch (error) { failures.push(error); }
      }
    } finally {
      clearTimeout(timer);
      unbindOperation();
      controller.signal.removeEventListener('abort', cancel);
      signal.removeEventListener('abort', abort);
      if (state?.page.operation === operation) state.page.operation = undefined;
      if (download) this.downloadingTabs.delete(tabId);
      if (unlock && !released) unlock();
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Browser operation or cleanup failed alongside physical drain', { cause: failures[0] });
    if (failures.length) throw failures[0];
    return response;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    const failures: unknown[] = [];
    await Promise.all([...this.tails.values()]);
    for (const pages of this.pages.values()) for (const state of pages.values()) {
      try { await this.releasePage(state); }
      catch (error) { failures.push(error); }
    }
    this.pages.clear();
    if (failures.length) throw new AggregateError(failures, 'IAB worker resource cleanup failed');
  }

  private async releasePage(state: PageState): Promise<void> {
    const controller = new AbortController();
    const operation: Operation = { signal: controller.signal, deadline: Date.now() + 10_000, assertCurrent: () => controller.signal.throwIfAborted(), tasks: new Set(), failures: [] };
    try { await this.services.teardown(state.lease, operation.signal, () => cleanupEmulation(state.page, operation)); }
    finally { this.disposePage(state); }
  }

  private disposePage(state: PageState): void {
    state.epoch++; state.ready = false;
    const pages = this.pages.get(state.lease.tabId);
    if (pages?.get(state.principalId) === state) {
      pages.delete(state.principalId);
      if (!pages.size) this.pages.delete(state.lease.tabId);
    }
    state.utilities.dispose(); state.page.dispose(); state.lease.release();
  }

  private async lockTab(tabId: string, signal: AbortSignal): Promise<() => void> {
    const previous = this.tails.get(tabId) ?? Promise.resolve();
    let resolve!: () => void;
    const tail = new Promise<void>((done) => { resolve = done; });
    this.tails.set(tabId, tail);
    const unlock = () => { resolve(); if (this.tails.get(tabId) === tail) this.tails.delete(tabId); };
    try { await waitForTurn(previous, signal); return unlock; }
    catch (error) { void previous.then(unlock); throw error; }
  }

  private async closeTab(tabId: string, context: AutomationContext): Promise<void> {
    const unlock = await this.lockTab(tabId, new AbortController().signal);
    try {
      context.assertCurrent();
      await this.services.checkTarget(tabId, context);
      for (const state of this.pages.get(tabId)?.values() ?? []) await this.releasePage(state);
      await this.services.closeTab(tabId, context);
      this.retainedTabs.delete(tabId);
    } finally { unlock(); }
  }

  private async getPage(tabId: string, context: AutomationContext, signal: AbortSignal): Promise<PageState> {
    signal.throwIfAborted(); context.assertCurrent();
    await this.services.checkTarget(tabId, context);
    const existing = this.pages.get(tabId)?.get(context.principalId);
    if (existing) return existing;
    const lease = await this.services.acquire(tabId, context, signal);
    // Broker detaches the acquisition signal once the persistent lease has been created.
    try { signal.throwIfAborted(); context.assertCurrent(); await this.services.checkTarget(tabId, context); }
    catch (error) { lease.release(); throw error; }
    const page = new IabAutomationPage(lease.executor);
    const state: PageState = { principalId: context.principalId, lease, page, utilities: new IabAutomationUtilities(page, () => { if (page.operation) lease.cancel(page.operation.signal); }), ready: false, epoch: 0 };
    lease.executor.onEvent((event) => {
      if (event.method === 'IAB.leaseRevoked') { this.disposePage(state); return; }
      if (event.method === 'IAB.epochInvalidated') { state.epoch++; state.ready = false; resetEmulation(page); }
    });
    if (this.disposed) { this.disposePage(state); throw iabError('IAB_AUTOMATION_CLOSED', 'IAB automation is closed'); }
    let pages = this.pages.get(tabId);
    if (!pages) { pages = new Map(); this.pages.set(tabId, pages); }
    pages.set(context.principalId, state);
    return state;
  }

  private async act(page: IabAutomationPage, request: BrowserActRequest, context: AutomationContext, tabId: string, operation: Operation): Promise<IabJsonObject> {
    const collectTabs = request.kind === 'click' || request.kind === 'clickCoords' || request.kind === 'press' || request.kind === 'type' && request.submit === true;
    const before = collectTabs ? new Set((await this.services.tabs(context)).tabs.map((tab) => tab.id)) : undefined;
    const started = Date.now();
    const result = await performAct(page, request, operation);
    if (result.observationComplete === false) return result;
    if (request.kind === 'press') result.key = request.key;
    try {
      if (['drag', 'dragCoords', 'hoverCoords', 'wheelCoords'].includes(request.kind ?? '')) {
        result.targetState = { targetId: tabId, url: await page.evaluate('location.href', operation) };
        result.durationMs = Date.now() - started;
      }
      if (before && result.actionPerformed !== false && result.ok !== false) {
        const deadline = Math.min(operation.deadline, Date.now() + 400);
        await page.pause(Math.min(80, Math.max(0, deadline - Date.now())), operation);
        for (;;) {
          operation.signal.throwIfAborted(); operation.assertCurrent?.();
          if (Date.now() >= operation.deadline) throw iabError('IAB_TIMEOUT', 'Post-action observation timed out');
          const tabs = (await this.services.tabs(context)).tabs.filter((tab) => !before.has(tab.id)).map((tab) => ({ targetId: tab.id, url: tab.url, title: tab.title }));
          if (tabs.length) {
            result.newTabs = tabs;
            result.hint = 'The action opened new tabs. Continue in the new tab targetId; the operated page may not have navigated.';
            break;
          }
          if (Date.now() >= deadline) break;
          await page.pause(Math.min(100, deadline - Date.now()), operation);
        }
      }
      return result;
    } catch (error) {
      operation.signal.throwIfAborted(); operation.assertCurrent?.();
      if (!(error instanceof Error) || !('code' in error) || !['IAB_TIMEOUT', 'IAB_WAIT_TIMEOUT'].includes(String(error.code))) throw error;
      return { ...result, actionPerformed: true, observationComplete: false, warning: { code: 'ACTION_OBSERVATION_TIMEOUT', message: 'The action was performed, but post-action observation timed out. Inspect the page before deciding what to do next; do not repeat the input automatically.' } };
    }
  }

  private async execute(params: BrowserActionParams, context: AutomationContext, tabId: string, state: PageState, operation: Operation): Promise<IabJsonObject> {
    const page = state.page;
    await this.services.checkTarget(tabId, context);
    switch (params.action) {
      case 'utility': {
        const request = params.request;
        if (!request) throw iabError('IAB_REQUEST_REQUIRED', 'A utility request is required');
        if (request.targetId && request.targetId !== tabId) throw iabError('IAB_TARGET_MISMATCH', 'Nested utility target does not match the owning tab');
        switch (request.kind) {
          case 'highlight': case 'upload': case 'dialog': case 'errors': case 'pdf': case 'cookies':
            return this.execute({ ...request, action: request.kind, targetId: tabId } as BrowserActionParams, context, tabId, state, operation);
          default: return state.utilities.execute(request, context, operation);
        }
      }
      case 'snapshot': return page.snapshot(params, operation);
      case 'navigate': {
        const url = validateUrl(params.url);
        context.assertCurrent();
        await this.services.show(tabId, context);
        page.invalidateRefs();
        const response = await page.send<IabJsonObject>('Page.navigate', { url }, operation);
        if (response.errorText) throw iabError('IAB_NAVIGATION_FAILED', String(response.errorText));
        await page.wait({ loadState: params.waitUntil ?? 'load' }, operation);
        return { ok: true, url: await page.evaluate('location.href', operation) };
      }
      case 'act':
        if (!params.request) throw iabError('IAB_REQUEST_REQUIRED', 'An act request is required');
        if (params.request.targetId && params.request.targetId !== tabId) throw iabError('IAB_TARGET_MISMATCH', 'Nested browser action target does not match the owning tab');
        return this.act(page, params.request, context, tabId, operation);
      case 'scroll': return scrollPage(page, params.scrollDirection, params.scrollAmount, operation);
      case 'console': {
        if (params.expression || params.scriptPath) {
          if (params.expression && params.scriptPath) throw iabError('IAB_CONSOLE_SOURCE_AMBIGUOUS', 'Use expression or scriptPath, not both');
          let expression = params.expression!;
          if (params.scriptPath) {
            expression = await context.readScript(params.scriptPath, operation.signal);
          }
          const result = params.ref
            ? await page.callElement(await page.resolveElement(params.ref, undefined, operation), `return (${expression})(this);`, [], operation)
            : await page.evaluateInFrame(expression, params.frameId, operation);
          const wrapped = result !== null && typeof result === 'object' && ('__debug' in result || '__result' in result);
          const payload = wrapped ? result.__result : result;
          const debugLines = wrapped && Array.isArray(result.__debug) ? result.__debug.map(String) : [];
          const output: string[] = [];
          if (debugLines.length) output.push(`[DEBUG]\n${debugLines.join('\n')}`);
          output.push(`[Result]\n${payload == null ? '(no return value)' : typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)}`);
          if (params.savePath) {
            if (payload == null) output.push('[Save] Skipped save (no return value).');
            else {
              try {
                const savedTo = await context.saveFile(params.savePath, Buffer.from(JSON.stringify(payload, null, 2)), operation.signal, true);
                output.push(`[Save] Written to ${savedTo}`);
              } catch (error) {
                operation.signal.throwIfAborted(); context.assertCurrent();
                const code = error instanceof Error && 'code' in error ? error.code : undefined;
                output.push(code === 'IAB_WORKSPACE_PATH_FORBIDDEN' ? '[Save] Skipped: path outside workspace or invalid.' : `[Save] Failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
          return { output: output.join('\n\n') };
        }
        return { messages: page.messages.filter((message) => !params.level || message.level === params.level) };
      }
      case 'errors': {
        const errors = [...page.errors];
        if (params.clear) page.errors.length = 0;
        return { errors };
      }
      case 'requests': {
        const requests = page.requests.filter((entry) => !params.filter || JSON.stringify(entry).includes(params.filter));
        if (params.clear) page.requests.length = 0;
        return { requests };
      }
      case 'dialog': {
        page.dialog = { accept: params.accept === true, ...(params.promptText === undefined ? {} : { promptText: params.promptText }) };
        return { ok: true, armed: true };
      }
      case 'cookies': {
        const operationKind = params.operation ?? 'get';
        if (operationKind === 'set') {
          await page.send('Network.setCookies', { cookies: params.cookies ?? [] }, operation);
          return { operation: operationKind };
        }
        if (operationKind === 'clear') {
          await page.send('Network.clearBrowserCookies', {}, operation);
          return { operation: operationKind };
        }
        const response = await page.send<IabJsonObject>('Network.getCookies', {}, operation);
        return { operation: operationKind, cookies: response.cookies ?? [] };
      }
      case 'storage': return storageOperation(page, params, operation);
      case 'highlight': {
        const updated = await page.refreshChangedRefs(params.backendNodeId === undefined ? [params.ref] : [], operation);
        if (updated) return updated;
        const element = await page.resolveElement(params.ref, undefined, operation, params);
        const duration = params.durationMs ?? 2000;
        if (!Number.isFinite(duration) || duration < 0 || duration > 60_000) throw iabError('IAB_HIGHLIGHT_DURATION_INVALID', 'Highlight duration must be between 0 and 60000ms');
        await page.callElement(element, 'const element=this;const old=element.style.outline;element.style.outline="3px solid #ff3860";setTimeout(()=>{element.style.outline=old},args[0]);return true;', [duration], operation);
        return { highlighted: true };
      }
      case 'screenshot': {
        const updated = await page.refreshChangedRefs([params.ref], operation);
        if (updated) return updated;
        if (params.ref && params.element) throw iabError('IAB_SCREENSHOT_SCOPE_INVALID', 'Use ref or element for a screenshot, not both');
        if (params.fullPage && (params.ref || params.element)) throw iabError('IAB_SCREENSHOT_SCOPE_INVALID', 'fullPage cannot be combined with an element screenshot');
        const type = params.type ?? 'png';
        const capture: Parameters<IabAutomationPage['captureScreenshot']>[0] = { format: type, fullPage: params.fullPage, scale: params.scale };
        if (type === 'jpeg' && params.quality !== undefined) {
          if (!Number.isInteger(params.quality) || params.quality < 0 || params.quality > 100) throw iabError('IAB_IMAGE_QUALITY_INVALID', 'JPEG quality must be between 0 and 100');
          capture.quality = params.quality;
        }
        const frames = await page.refreshFrames(operation);
        const animations: { frame: typeof frames[number] }[] = [];
        const screenshotEpoch = state.epoch;
        try {
          if (params.ref || params.element) capture.clip = await page.elementClip(params.ref, params.element, operation);
          for (const frame of frames) {
            await page.evaluate(`(() => {globalThis.__matchaIabScreenshotCleanup?.();const style=document.createElement('style');style.id='__matchaIabScreenshot';style.textContent=${JSON.stringify(params.caret !== 'initial' ? '*{caret-color:transparent!important}' : '')};document.documentElement.append(style);const paused=[];${params.animations === 'disabled' ? "for(const animation of document.getAnimations()){if(animation.playState==='running'){paused.push(animation);animation.pause();}}" : ''}let timer;const cleanup=()=>{clearTimeout(timer);style.remove();for(const animation of paused)if(animation.playState==='paused')animation.play();delete globalThis.__matchaIabScreenshotCleanup};globalThis.__matchaIabScreenshotCleanup=cleanup;timer=setTimeout(cleanup,${Math.max(1, operation.deadline - Date.now())});return true;})()`, operation, frame);
            animations.push({ frame });
          }
          if (params.omitBackground) await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, operation);
          const imageBase64 = await page.captureScreenshot(capture, operation);
          const savedTo = params.savePath ? await context.saveFile(params.savePath, Buffer.from(imageBase64, 'base64'), operation.signal) : undefined;
          return { imageBase64, imageType: type, ...(savedTo ? { savedTo } : {}) };
        } finally {
          if (state.epoch === screenshotEpoch) {
            for (const { frame } of animations) {
              try { await page.evaluate('globalThis.__matchaIabScreenshotCleanup?.()', operation, frame); }
              catch (error) { operation.failures.push(error); }
            }
            if (params.omitBackground && state.epoch === screenshotEpoch) {
              try { await page.send('Emulation.setDefaultBackgroundColorOverride', undefined, operation); }
              catch (error) { operation.failures.push(error); }
            }
          }
        }
      }
      case 'pdf': {
        const papers = { a3: [11.69, 16.54], a4: [8.27, 11.69], a5: [5.83, 8.27], letter: [8.5, 11], legal: [8.5, 14], tabloid: [11, 17], ledger: [17, 11] };
        const paper = params.paper === undefined ? undefined : papers[params.paper.trim().toLowerCase() as keyof typeof papers];
        if (params.paper !== undefined && !paper) throw iabError('IAB_PDF_PAPER_INVALID', 'Unknown PDF paper size');
        if (params.scale !== undefined && !Number.isFinite(params.scale)) throw iabError('IAB_PDF_SCALE_INVALID', 'PDF scale must be finite');
        const result = await page.send<any>('Page.printToPDF', { transferMode: 'ReturnAsBase64', ...(params.landscape === true ? { landscape: true } : {}), ...(params.printBackground === true ? { printBackground: true } : {}), ...(paper ? { paperWidth: paper[params.landscape ? 1 : 0], paperHeight: paper[params.landscape ? 0 : 1] } : {}), ...(params.scale === undefined ? {} : { scale: Math.min(2, Math.max(0.1, params.scale)) }) }, operation);
        const savedTo = params.savePath ? await context.saveFile(params.savePath, Buffer.from(result.data, 'base64'), operation.signal) : undefined;
        return { pdfBase64: result.data, ...(savedTo ? { savedTo } : {}) };
      }
      case 'upload': {
        const updated = await page.refreshChangedRefs(params.backendNodeId === undefined ? [params.ref, params.inputRef] : [], operation);
        if (updated) return updated;
        if (!params.paths?.length) throw iabError('IAB_UPLOAD_PATHS_REQUIRED', 'At least one workspace file is required');
        const files = await context.resolveFiles(params.paths, operation.signal);
        if (params.ref && !params.inputRef) {
          let chooser: { params: IabJsonObject; sessionId?: string } | undefined;
          const stop = page.executor.onEvent((event) => { if (event.method === 'Page.fileChooserOpened') chooser = event; });
          try {
            const point = await page.actionablePoint(params.ref, undefined, operation);
            await clickPoint(page, point, operation);
            while (!chooser) await page.pause(25, operation);
            const event = chooser as { params: IabJsonObject; sessionId?: string };
            if (event.params.mode !== 'selectMultiple' && files.length > 1) throw iabError('IAB_UPLOAD_INPUT_INVALID', 'File chooser does not support multiple files');
            await page.send('DOM.setFileInputFiles', { backendNodeId: event.params.backendNodeId, files }, operation, event.sessionId);
            return { uploaded: files.length };
          } finally { stop(); }
        }
        const element = await page.resolveElement(params.inputRef, params.element ?? (!params.inputRef && params.backendNodeId === undefined ? 'input[type=file]' : undefined), operation, params);
        const metadata = await page.callElement(element, 'return {file:this.nodeName==="INPUT"&&this.type==="file",multiple:this.multiple};', [], operation);
        if (!metadata.file || (!metadata.multiple && files.length > 1)) throw iabError('IAB_UPLOAD_INPUT_INVALID', 'Upload requires a file input supporting the selected file count');
        await page.send('DOM.setFileInputFiles', { objectId: element.objectId, files }, operation, element.frame.sessionId);
        return { uploaded: files.length };
      }
      default: throw iabError('IAB_ACTION_UNSUPPORTED', `Browser action is not supported: ${params.action}`);
    }
  }
}

function validateUrl(value: string | undefined): string {
  if (value === 'about:blank') return value;
  if (!value) throw iabError('IAB_URL_REQUIRED', 'A browser URL is required');
  let url: URL;
  try { url = new URL(value); } catch { throw iabError('IAB_URL_INVALID', 'Browser URL must be absolute HTTP or HTTPS'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw iabError('IAB_URL_FORBIDDEN', 'Browser URL must be HTTP/HTTPS without embedded credentials');
  return url.href;
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    previous.then(() => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(signal.reason); else resolve(); }, reject);
    if (signal.aborted) abort();
  });
}
