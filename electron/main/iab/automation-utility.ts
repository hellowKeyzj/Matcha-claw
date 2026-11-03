import type { BrowserInterceptRule, BrowserRuntimeSettings, BrowserUtilityRequest } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabJsonObject, IabJsonValue } from '../../../src/types/desktop/iab';
import type { AutomationContext } from './automation-port';
import { captureSom } from './automation-som';
import type { IabAutomationPage, Operation } from './automation-page';
import { readScripts, readSourceMap } from './automation-scripts';
import { readRawTree } from './automation-snapshot';
import { emulate } from './automation-emulation';
import { iabError } from './error';

const stealthSource = `(() => {
  try { Object.defineProperty(navigator,'webdriver',{get:()=>undefined}) } catch {}
  try { Object.defineProperty(navigator,'languages',{configurable:true,get:()=>['zh-CN','zh','en']}) } catch {}
  try { const make=name=>({name,filename:'internal-pdf-viewer',description:name,length:1});const arr=[make('Chrome PDF Viewer'),make('Chrome PDF Plugin'),make('Native Client')];arr.item=i=>arr[i];arr.namedItem=n=>arr.find(p=>p.name===n)||null;arr.refresh=()=>{};Object.defineProperty(navigator,'plugins',{get:()=>arr}) } catch {}
  try { const query=navigator.permissions.query.bind(navigator.permissions);navigator.permissions.query=params=>params&&params.name==='notifications'?Promise.resolve({state:Notification.permission}):query(params) } catch {}
  try { window.chrome=window.chrome||{runtime:{}} } catch {}
})()`;

export class IabAutomationUtilities {
  private rules: BrowserInterceptRule[] = [];
  private cacheBypass = false;
  private readonly configuredSessions = new Set<string>();
  private readonly stealthSessions = new Set<string>();
  private readonly stop: () => void;
  private readonly tasks = new Set<Promise<unknown>>();
  private disposed = false;

  constructor(private readonly page: IabAutomationPage, private readonly cancel: () => void) {
    this.stop = page.executor.onEvent((event) => {
      if (event.method === 'IAB.epochInvalidated') { this.configuredSessions.clear(); this.stealthSessions.clear(); }
      try { page.assertCurrent(); } catch { return; }
      if (event.method === 'IAB.childFrameAttached' && typeof event.params.sessionId === 'string' && page.operation) this.track(this.configureSession(event.params.sessionId, page.operation));
    });
  }

  dispose(): void { this.disposed = true; this.stop(); }

  async initialize(operation: Operation): Promise<void> {
    if (!this.rules.length && !this.cacheBypass && !this.page.settings.stealth) return;
    for (const frame of await this.page.refreshFrames(operation)) await this.configureSession(frame.sessionId, operation);
  }

  async execute(request: BrowserUtilityRequest, context: AutomationContext, operation: Operation): Promise<IabJsonObject> {
    switch (request.kind) {
      case 'frames': {
        const frames = await this.page.refreshFrames(operation);
        return { frames: frames.map((frame) => ({ frameId: frame.id, url: frame.url, ...(frame.parentId ? { parentId: frame.parentId } : {}), ...(frame.name ? { name: frame.name } : {}), oopif: !!frame.sessionId })), completeness: 'complete' };
      }
      case 'goBack': case 'goForward': case 'reload': return this.navigate(request, operation);
      case 'a11yTree': case 'domTree': return readRawTree(this.page, request, operation);
      case 'scripts': {
        const scripts = await readScripts(this.page, request, operation);
        return { scripts, count: scripts.length };
      }
      case 'sourceMap': return readSourceMap(this.page, request, operation);
      case 'events': {
        const events = this.page.events.filter((entry) => (!request.filter || entry.kind === request.filter) && (!Number.isFinite(request.since) || Number(entry.seq) > request.since!));
        if (request.clear === true) this.page.events.length = 0;
        return { events };
      }
      case 'requests': {
        await this.page.settleEvents(operation);
        const requests = this.page.readRequests(request.filter);
        if (request.clear === true) this.page.requests.length = 0;
        return { requests: typeof request.last === 'number' && Number.isFinite(request.last) && request.last > 0 && requests.length > request.last ? requests.slice(requests.length - Math.floor(request.last)) : requests };
      }
      case 'har': {
        if (typeof request.savePath !== 'string' || !request.savePath) throw iabError('IAB_HAR_PATH_REQUIRED', 'HAR savePath is required (a .har file inside the workspace)');
        await this.page.settleEvents(operation);
        let requests = this.page.requests.filter((entry) => !request.filter || String((entry.request as IabJsonObject | undefined)?.url ?? '').toLowerCase().includes(request.filter.toLowerCase()));
        if (typeof request.last === 'number' && Number.isFinite(request.last) && request.last > 0 && requests.length > request.last) requests = requests.slice(requests.length - Math.floor(request.last));
        const har = { log: { version: '1.2', creator: { name: 'Matcha', version: '1.0' }, entries: requests.filter((entry) => (entry.request as IabJsonObject | undefined)?.url).map(harEntry) } };
        const content = JSON.stringify(har, null, 2);
        const savePath = await context.saveFile(request.savePath, Buffer.from(content), operation.signal);
        if (request.clear === true) this.page.requests.length = 0;
        return { entries: har.log.entries.length, savePath, bytes: content.length };
      }
      case 'settings': return this.updateSettings(request.settings, operation);
      case 'som': return captureSom(this.page, request, operation);
      case 'intercept': {
        const rules = typeof request.rules === 'string' ? JSON.parse(request.rules) : request.rules;
        if (rules !== undefined) validateRules(rules);
        if (request.clear !== undefined && request.clear !== true) throw iabError('IAB_INTERCEPT_CLEAR_INVALID', 'Interception clear must be true when provided');
        if (request.cacheBypass !== undefined && typeof request.cacheBypass !== 'boolean') throw iabError('IAB_INTERCEPT_CACHE_INVALID', 'Interception cacheBypass must be a boolean');
        if (request.clear === true || rules !== undefined) {
          const nextRules = request.clear === true ? [] : rules!;
          this.configuredSessions.delete('');
          if (nextRules.length) {
            await this.page.executor.setInterceptPolicy(nextRules, { signal: operation.signal, assertCurrent: operation.assertCurrent });
            try { await this.page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, operation); }
            catch (error) {
              const failures: unknown[] = [error];
              try { await this.page.executor.setInterceptPolicy(this.rules, { signal: operation.signal, assertCurrent: operation.assertCurrent }); }
              catch (cleanupError) { failures.push(cleanupError); }
              if (failures.length > 1) throw new AggregateError(failures, 'Interception setup and policy restoration failed', { cause: error });
              throw error;
            }
          } else {
            await this.page.send('Fetch.disable', undefined, operation);
            await this.page.executor.setInterceptPolicy(nextRules, { signal: operation.signal, assertCurrent: operation.assertCurrent });
          }
          this.rules = nextRules;
          this.configuredSessions.add('');
        }
        if (request.cacheBypass !== undefined && request.cacheBypass !== this.cacheBypass) {
          await this.page.send('Network.setCacheDisabled', { cacheDisabled: request.cacheBypass }, operation);
          this.cacheBypass = request.cacheBypass;
        }
        const enabled = this.rules.length > 0 && this.configuredSessions.has('');
        return { rules: [...this.rules] as unknown as IabJsonValue, cacheBypass: this.cacheBypass, enabled, ...(enabled ? { note: 'intercept rules must be re-applied after navigation' } : {}) };
      }
      case 'metrics': {
        const failures: unknown[] = [];
        let metrics: IabJsonValue = [];
        try {
          await this.page.send('Performance.enable', undefined, operation);
          const result = await this.page.send<any>('Performance.getMetrics', undefined, operation);
          metrics = (Array.isArray(result?.metrics) ? result.metrics : []).flatMap((entry: any) => {
            if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') return [];
            const value = typeof entry.value === 'number' ? entry.value : Number(entry.value);
            return Number.isFinite(value) ? [{ name: entry.name, value }] : [];
          });
        } catch (error) { failures.push(error); }
        try { await this.page.send('Performance.disable', undefined, operation); }
        catch (error) { failures.push(error); }
        if (failures.length > 1) throw new AggregateError(failures, 'Performance inspection or cleanup failed', { cause: failures[0] });
        if (failures.length) throw failures[0];
        return { metrics };
      }
      case 'emulate': return emulate(this.page, request, operation);
      default: throw iabError('IAB_UTILITY_DISPATCH_INVALID', `Utility must be dispatched by its existing action owner: ${request.kind}`);
    }
  }

  private async navigate(request: Extract<BrowserUtilityRequest, { kind: 'goBack' | 'goForward' | 'reload' }>, operation: Operation): Promise<IabJsonObject> {
    const started = Date.now();
    type NavigationState = { href: string; timeOrigin: number | null; entryId: string | null };
    const readState = async (): Promise<NavigationState | null> => {
      try {
        const state = await this.page.evaluate('({href:location.href,timeOrigin:performance.timeOrigin,entryId:window.navigation?.currentEntry?.id??null})', operation);
        if (!state || typeof state !== 'object') return null;
        return { href: typeof state.href === 'string' ? state.href : '', timeOrigin: typeof state.timeOrigin === 'number' ? state.timeOrigin : null, entryId: typeof state.entryId === 'string' ? state.entryId : null };
      } catch (error) {
        operation.signal.throwIfAborted();
        (operation.assertCurrent ?? this.page.assertCurrent)();
        if (operation.deadline <= Date.now() || error instanceof Error && (error.name === 'TimeoutError' || 'code' in error && error.code !== 'IAB_EVALUATION_FAILED')) throw error;
        return null;
      }
    };
    let before: NavigationState | null;
    let entry: IabJsonObject | undefined;
    let history: IabJsonObject | undefined;
    if (request.kind === 'reload') {
      if (request.ignoreCache !== undefined && typeof request.ignoreCache !== 'boolean') throw iabError('IAB_RELOAD_CACHE_INVALID', 'ignoreCache must be a boolean');
      before = await readState();
      await this.page.send('Page.reload', request.ignoreCache === true ? { ignoreCache: true } : undefined, operation);
    } else {
      let current;
      try { current = await this.page.send<any>('Page.getNavigationHistory', undefined, operation); }
      catch (error) {
        operation.signal.throwIfAborted(); (operation.assertCurrent ?? this.page.assertCurrent)();
        if (operation.deadline <= Date.now() || error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || 'code' in error)) throw error;
        throw iabError('IAB_NO_HISTORY_ENTRY', `Navigation history could not be read for this tab: ${error instanceof Error ? error.message : String(error)}`);
      }
      const entries = Array.isArray(current?.entries) ? current.entries : [];
      const currentIndex = typeof current?.currentIndex === 'number' ? current.currentIndex : -1;
      const index = currentIndex + (request.kind === 'goBack' ? -1 : 1);
      entry = currentIndex < 0 ? undefined : entries[index];
      if (!entry || typeof entry.id !== 'number') throw iabError('IAB_NO_HISTORY_ENTRY', `No ${request.kind === 'goBack' ? 'back' : 'forward'} history entry for this tab`);
      history = { index, size: entries.length };
      before = await readState();
      await this.page.send('Page.navigateToHistoryEntry', { entryId: entry.id }, operation);
    }
    let after = before;
    const expectedUrl = typeof entry?.url === 'string' ? entry.url : '';
    if (before && (request.kind === 'reload' ? before.timeOrigin !== null : expectedUrl !== '')) {
      for (;;) {
        after = await readState();
        const committed = after && (request.kind === 'reload' ? after.timeOrigin !== null && after.timeOrigin !== before.timeOrigin : after.href === expectedUrl && (before.entryId !== null && after.entryId !== null ? before.entryId !== after.entryId : before.href !== after.href || before.timeOrigin !== null && after.timeOrigin !== null && before.timeOrigin !== after.timeOrigin));
        if (committed) break;
        await this.page.pause(100, operation);
      }
    }
    await this.page.wait({ loadState: 'load' }, operation);
    const url = expectedUrl || after?.href || before?.href || '';
    return { source: request.kind === 'reload' ? 'reload' : 'history', url, fromUrl: before?.href ?? '', loadState: 'load', durationMs: Date.now() - started, targetState: { targetId: request.targetId!, url }, ...(request.kind === 'reload' ? request.ignoreCache === true ? { ignoreCache: true } : {} : { direction: request.kind === 'goBack' ? 'back' : 'forward', entry: entry!, history: history! }) };
  }

  private async updateSettings(input: BrowserRuntimeSettings | string | undefined, operation: Operation): Promise<IabJsonObject> {
    const settings = typeof input === 'string' ? JSON.parse(input) : input;
    if (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings))) throw iabError('IAB_SETTINGS_INVALID', 'settings must be an object');
    if (settings?.stealth !== undefined && (!settings.stealth || typeof settings.stealth !== 'object' || settings.stealth.enabled !== true)) throw iabError('IAB_STEALTH_ONE_WAY', 'Stealth can only be enabled and remains active until the tab closes');
    if (settings?.pace !== undefined) {
      if (settings.pace === null) delete this.page.settings.pace;
      else {
        const minIntervalMs = Math.max(0, Math.floor(settings.pace.minIntervalMs || 0));
        const jitterMs = settings.pace.jitterMs === undefined ? undefined : Math.max(0, Math.floor(settings.pace.jitterMs));
        if (minIntervalMs > 0) this.page.settings.pace = { minIntervalMs, ...(jitterMs === undefined ? {} : { jitterMs }) };
        else delete this.page.settings.pace;
      }
    }
    if (settings?.humanize !== undefined) {
      if (settings.humanize === null || settings.humanize === false) delete this.page.settings.humanize;
      else this.page.settings.humanize = true;
    }
    if (settings?.stealth !== undefined && !this.page.settings.stealth) {
      for (const sessionId of new Set([undefined, ...(await this.page.executor.listChildFrames({ signal: operation.signal, timeoutMs: Math.max(1, operation.deadline - Date.now()), assertCurrent: operation.assertCurrent ?? this.page.assertCurrent })).map((frame) => frame.sessionId)])) await this.configureStealth(sessionId, operation);
      this.page.settings.stealth = { enabled: true };
    }
    return { settings: { ...this.page.settings } };
  }

  private async configureSession(sessionId: string | undefined, operation: Operation): Promise<void> {
    const key = sessionId ?? '';
    if (key === '' && !this.configuredSessions.has(key)) {
      await this.page.send('Network.setCacheDisabled', { cacheDisabled: this.cacheBypass }, operation, sessionId);
      await this.page.executor.setInterceptPolicy(this.rules, { signal: operation.signal, assertCurrent: operation.assertCurrent });
      if (this.rules.length) await this.page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, operation, sessionId);
      else await this.page.send('Fetch.disable', undefined, operation, sessionId);
      this.configuredSessions.add(key);
    }
    if (this.page.settings.stealth) await this.configureStealth(sessionId, operation);
  }

  private async configureStealth(sessionId: string | undefined, operation: Operation): Promise<void> {
    const key = sessionId ?? '';
    if (this.stealthSessions.has(key)) return;
    await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source: stealthSource }, operation, sessionId);
    await this.page.send('Runtime.evaluate', { expression: stealthSource, returnByValue: true }, operation, sessionId);
    this.stealthSessions.add(key);
  }

  private track(task: Promise<unknown>): void {
    this.tasks.add(task);
    this.page.trackOperation(task);
    void task.catch(() => { if (!this.disposed) this.cancel(); }).finally(() => this.tasks.delete(task));
  }
}

function validateRules(value: unknown): asserts value is BrowserInterceptRule[] {
  if (!Array.isArray(value) || value.length > 50) throw iabError('IAB_INTERCEPT_RULES_INVALID', 'Interception rules must be an array of at most 50 rules');
  for (const rule of value) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.pattern !== 'string' || !rule.pattern.trim() || rule.pattern.length > 512 || !['block', 'mock', 'modify', 'continue'].includes(rule.action)) throw iabError('IAB_INTERCEPT_RULE_INVALID', 'Each rule requires a nonempty pattern of at most 512 characters and valid action');
    if (rule.match !== undefined && rule.match !== 'substring' && rule.match !== 'glob') throw iabError('IAB_INTERCEPT_MATCH_INVALID', 'Interception match must be substring or glob');
    if (rule.match === undefined && rule.pattern.length > 1 && rule.pattern.startsWith('/') && rule.pattern.endsWith('/')) throw iabError('IAB_INTERCEPT_MATCH_INVALID', 'JavaScript regex is not supported; specify substring or glob explicitly');
    if (rule.method !== undefined && typeof rule.method !== 'string' || rule.contentType !== undefined && typeof rule.contentType !== 'string') throw iabError('IAB_INTERCEPT_RULE_INVALID', 'Interception method and contentType must be strings');
    if (rule.status !== undefined && (!Number.isInteger(rule.status) || rule.status < 100 || rule.status > 599)) throw iabError('IAB_INTERCEPT_STATUS_INVALID', 'Mock status must be between 100 and 599');
    if (rule.headers !== undefined && (!rule.headers || typeof rule.headers !== 'object' || Object.entries(rule.headers).some(([name, entry]) => /[\r\n]/u.test(name) || typeof entry !== 'string' || /[\r\n]/u.test(entry)))) throw iabError('IAB_INTERCEPT_HEADERS_INVALID', 'Interception headers must contain string values without newlines');
    if (rule.body !== undefined && typeof rule.body !== 'string') throw iabError('IAB_INTERCEPT_BODY_INVALID', 'Interception body must be a string');
  }
}

function harEntry(entry: IabJsonObject): IabJsonObject {
  const request = entry.request as any ?? {}, response = entry.response as any ?? {};
  const headers = (value: Record<string, unknown> = {}) => Object.entries(value).map(([name, item]) => ({ name, value: String(item) }));
  const timing = response.timing;
  const elapsed = Math.max(0, Number(entry.finishedAt ?? entry.startedAt) - Number(entry.startedAt));
  let queryString: { name: string; value: string }[] = [];
  try { queryString = [...new URL(request.url).searchParams].map(([name, value]) => ({ name, value })); } catch { /* Non-HTTP page resources have no URL query. */ }
  return {
    startedDateTime: new Date(Number(entry.startedAt)).toISOString(), time: elapsed,
    request: { method: request.method ?? 'GET', url: request.url ?? '', httpVersion: response.protocol ?? '', headers: headers(request.headers), queryString, cookies: [], headersSize: -1, bodySize: request.postData ? Buffer.byteLength(request.postData) : 0, ...(request.postData ? { postData: { mimeType: request.headers?.['Content-Type'] ?? '', text: request.postData } } : {}) },
    response: { status: response.status ?? 0, statusText: response.statusText ?? '', httpVersion: response.protocol ?? '', headers: headers(response.headers), cookies: [], redirectURL: response.headers?.location ?? '', headersSize: -1, bodySize: entry.encodedDataLength ?? -1, content: { size: entry.encodedDataLength ?? 0, mimeType: response.mimeType ?? '', ...(entry.body === undefined ? {} : { text: entry.body, ...(entry.base64Encoded ? { encoding: 'base64' } : {}) }), ...(entry.bodyError ? { _error: entry.bodyError } : {}), ...(entry.bodyTruncated ? { _truncated: true } : {}) } },
    cache: {}, timings: { blocked: -1, dns: timing?.dnsEnd >= 0 ? timing.dnsEnd - timing.dnsStart : -1, connect: timing?.connectEnd >= 0 ? timing.connectEnd - timing.connectStart : -1, ssl: timing?.sslEnd >= 0 ? timing.sslEnd - timing.sslStart : -1, send: timing?.sendEnd >= 0 ? timing.sendEnd - timing.sendStart : 0, wait: timing?.receiveHeadersEnd >= 0 ? timing.receiveHeadersEnd - timing.sendEnd : elapsed, receive: 0 },
    ...(entry.failure ? { _failure: entry.failure } : {}),
  };
}
