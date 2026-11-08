import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { UseElectron } from './use-electron.ability.js';
import type { IabTestSite } from './iab-test-site.ability.js';
import type { IabBrowserTools } from './iab-browser-tools.ability.js';
import type { IabDesktop } from './iab-desktop.ability.js';

type CaseId = 10 | 11 | 12;
type Identity = { endpoint: { kind: string; runtimeAdapterId: string; runtimeInstanceId: string }; agentId: string; sessionKey: string };
type Receipt = { seq: number; stage: string; detail?: unknown };
type Open = { label: string; scope: string; held: boolean; delivered: boolean; ownerId?: string; tabId?: string; revision?: number; release?: () => void };
type Creation = { label: string; identity?: Identity; failed?: boolean };
type Bridge = { ipcRenderer: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }; [key: string]: unknown };
type Harness = {
  owner: string; receipts: Receipt[]; opens: Open[]; creates: Creation[];
  arm(label: string, hold: boolean): void; expectCreate(label: string): void; release(): void;
  mark(stage: string, detail?: unknown): void; dispose(): void;
  track(channel: string, args: unknown[], original: Promise<unknown>): Promise<unknown>;
};
type Cdp = Awaited<ReturnType<ReturnType<UseElectron['page']['context']>['newCDPSession']>>;
type HarnessOperation = { owner: string; operation: 'read' | 'mark' | 'arm' | 'expectCreate' | 'release' | 'dispose'; label?: string; hold?: boolean; stage?: string; detail?: unknown };
type HarnessWindow = { electron: Bridge; __iabWorkspaceRace?: Harness };
type Snapshot = {
  ownerId: string; revision: number; activeTabId: string | null;
  tabs: { ownerId: string; id: string; url: string; display: { kind: string; scope?: string; sessionIds?: string[] } }[];
  views: { tabId: string; bounds: { x: number; y: number; width: number; height: number } }[];
};
type Baseline = {
  sessionTitle: string | null; sessionGroup: string | null; agentExpanded: boolean;
  sideVisible: boolean; fullscreen: boolean; selectedMain: string | null; selectedSide: string | null;
  native: Snapshot;
};
type BrowserPage = { ownerId: string; tabId: string; pageId: string; scope: string;
  pane?: string; url?: string; webContentsId?: number; documentToken?: string; text?: string };
type Readback = { receipts: Receipt[]; opens: Omit<Open, 'release'>[]; creates: Creation[] };

const timeout = 15_000;
const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
const prompt = 'Do not use tools. Reply only OK.';

// Runs in the existing Renderer/preload world, never imports or replaces business code.
function installHarness({ owner, mode }: { owner: string; mode: 'root' | 'cdp' }) {
  const host = window as unknown as HarnessWindow;
  const original = Object.getOwnPropertyDescriptor(window, 'electron');
  const descriptor = { exists: !!original, configurable: original?.configurable === true,
    writable: original && 'writable' in original ? original.writable : null, accessor: !!original && !('value' in original) };
  if (mode === 'root' && !original?.configurable) return descriptor;
  if (host.__iabWorkspaceRace) throw new Error('Another IAB race observer is installed');
  const bridge = host.electron;
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  let seq = 0;
  let armed: { label: string; hold: boolean } | undefined;
  let expectedCreate: string | undefined;
  let replacement: Bridge | undefined;
  const state: Harness = {
    owner, receipts: [], opens: [], creates: [],
    mark(stage, detail) { state.receipts.push({ seq: ++seq, stage, detail }); },
    arm(label, hold) {
      if (armed || state.opens.some(open => open.label === label)) throw new Error('Open gate cannot be rearmed or replayed');
      armed = { label, hold };
    },
    expectCreate(label) {
      if (expectedCreate || state.creates.some(create => create.label === label)) throw new Error('Native create cannot be replayed');
      expectedCreate = label;
    },
    release() { for (const open of state.opens) open.release?.(); },
    dispose() {
      state.release();
      window.removeEventListener('workspace:session-promoted', promoted);
      if (mode === 'root') {
        if (host.electron !== replacement) throw new Error('Another owner changed the root bridge; its descriptor was not overwritten');
        Object.defineProperty(window, 'electron', original!);
      }
      delete host.__iabWorkspaceRace;
    },
    async track(channel, args, originalPromise) {
      const request = args[0];
      const command = channel === 'iab:command' && record(request) && record(request.command) ? request.command : undefined;
      let opening: Open | undefined;
      let releasePromise: Promise<void> | undefined;
      if (armed && command?.action === 'open' && command.url === 'about:blank' && command.background !== true && typeof command.displayScope === 'string') {
        opening = { label: armed.label, scope: command.displayScope, held: armed.hold, delivered: false };
        armed = undefined;
        if (opening.held) releasePromise = new Promise<void>(resolve => { opening!.release = resolve; });
        state.opens.push(opening);
        state.mark('open-dispatched', { label: opening.label, displayScope: opening.scope });
      }
      let body: unknown;
      if (channel === 'hostapi:fetch' && record(request) && request.path === '/api/capabilities/execute') {
        try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; } catch { body = undefined; }
      }
      let creation: Creation | undefined;
      if (expectedCreate && record(body) && body.operationId === 'sessions.create') {
        creation = { label: expectedCreate };
        expectedCreate = undefined;
        state.creates.push(creation);
        state.mark('create-dispatched', { label: creation.label, requestId: record(request) ? request.requestId : undefined });
      }
      if (command?.action === 'promote-display-scope') state.mark('promotion-dispatched', { from: command.from, to: command.to });
      let response: unknown;
      try { response = await originalPromise; }
      catch (error) {
        if (creation) creation.failed = true;
        if (opening || creation) state.mark('ipc-rejected', { label: opening?.label ?? creation?.label, channel });
        throw error;
      }
      if (creation) {
        const data = record(response) && response.ok === true && record(response.data) && response.data.ok === true ? response.data.json : undefined;
        const identity = record(data) && record(data.identity) ? data.identity : undefined;
        if (identity && record(identity.endpoint) && identity.endpoint.kind === 'native-runtime'
          && identity.endpoint.runtimeAdapterId === 'openclaw' && identity.endpoint.runtimeInstanceId === 'local'
          && typeof identity.agentId === 'string' && typeof identity.sessionKey === 'string'
          && record(data) && data.sessionKey === identity.sessionKey) {
          creation.identity = { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
            agentId: identity.agentId, sessionKey: identity.sessionKey };
        } else creation.failed = true;
        state.mark('create-native-response', { label: creation.label, identity: creation.identity, failed: creation.failed === true });
      }
      if (opening) {
        if (record(response) && typeof response.ownerId === 'string' && typeof response.revision === 'number'
          && record(response.result) && response.result.resultType === 'opened' && typeof response.result.tabId === 'string') {
          opening.ownerId = response.ownerId;
          opening.revision = response.revision;
          opening.tabId = response.result.tabId;
        }
        state.mark('open-native-response', { label: opening.label, ownerId: opening.ownerId, tabId: opening.tabId, revision: opening.revision });
        if (releasePromise) await releasePromise;
        opening.held = false;
        opening.delivered = true;
        state.mark('open-delivered', { label: opening.label, ownerId: opening.ownerId, tabId: opening.tabId });
      }
      if (command?.action === 'promote-display-scope') {
        const result = record(response) && record(response.result) ? response.result : undefined;
        state.mark('promotion-native-response', { from: command.from, to: command.to, resultType: result?.resultType,
          revision: record(response) ? response.revision : undefined });
      }
      return response;
    },
  };
  const promoted = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (record(detail) && typeof detail.fromScopeKey === 'string' && typeof detail.draftId === 'string' && typeof detail.toScopeKey === 'string') {
      state.mark('session-promoted', { fromScopeKey: detail.fromScopeKey, draftId: detail.draftId, toScopeKey: detail.toScopeKey });
    }
  };
  if (mode === 'root') {
    replacement = { ...bridge, ipcRenderer: { ...bridge.ipcRenderer,
      invoke: (channel: string, ...args: unknown[]) => state.track(channel, args, bridge.ipcRenderer.invoke(channel, ...args)) } };
    Object.defineProperty(window, 'electron', { configurable: true, enumerable: original!.enumerable, writable: true, value: replacement });
  }
  host.__iabWorkspaceRace = state;
  window.addEventListener('workspace:session-promoted', promoted);
  state.mark('harness-installed', { mode, descriptor });
  return descriptor;
}

function operateHarness(input: HarnessOperation): Readback | undefined {
  const state = (window as unknown as HarnessWindow).__iabWorkspaceRace;
  if (state?.owner !== input.owner) throw new Error('IAB race observer ownership changed');
  switch (input.operation) {
    case 'read': return { receipts: state.receipts, creates: state.creates, opens: state.opens.map(open => ({
      label: open.label, scope: open.scope, held: open.held, delivered: open.delivered,
      ownerId: open.ownerId, tabId: open.tabId, revision: open.revision,
    })) };
    case 'mark': state.mark(input.stage!, input.detail); break;
    case 'arm': state.arm(input.label!, input.hold!); break;
    case 'expectCreate': state.expectCreate(input.label!); break;
    case 'release': state.mark('release-requested', {}); state.release(); break;
    case 'dispose': state.dispose(); break;
  }
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameIdentity = (left: Identity, right: Identity) => left.sessionKey === right.sessionKey && left.agentId === right.agentId
  && left.endpoint.kind === right.endpoint.kind && left.endpoint.runtimeAdapterId === right.endpoint.runtimeAdapterId
  && left.endpoint.runtimeInstanceId === right.endpoint.runtimeInstanceId;

export class IabWorkspaceRaces extends Ability {
  constructor(private readonly electron: UseElectron, private readonly site: IabTestSite,
    private readonly tools: IabBrowserTools, private readonly desktop: IabDesktop) { super(); }

  private owner = '';
  private installed = false;
  private cdp?: Cdp;
  private cdpContext?: number;
  private readonly breakpoints: string[] = [];
  private readonly debugFailures: unknown[] = [];
  private pausedWork: Promise<void> = Promise.resolve();
  private agentTitle = '';
  private readonly evidence: { stage: string; detail: unknown }[] = [];
  private get main() { return this.electron.page; }
  private get sessions() { return this.main.getByTestId('agent-sessions-pane'); }
  private get side() { return this.main.locator('[data-workspace-pane="side"]'); }
  private get mainPane() { return this.main.locator('[data-workspace-pane="main"]'); }
  private tab(id: string) { return this.main.locator(`[role="tab"][data-page-id=${JSON.stringify(id)}]`); }
  private group(title = this.agentTitle) { return this.sessions.locator('section').filter({ has: this.main.locator(`button[aria-controls][title=${JSON.stringify(title)}]`) }).last(); }
  private header(title = this.agentTitle) { return this.sessions.locator(`button[aria-controls][title=${JSON.stringify(title)}]`); }

  async verify(caseId: CaseId, iteration: number): Promise<boolean> {
    if (![10, 11, 12].includes(caseId) || !Number.isInteger(iteration) || iteration < 1 || iteration > 5) throw new Error('Unknown IAB race iteration');
    this.owner = `iab-race-${caseId}-${iteration}-${randomUUID()}`;
    this.installed = false;
    this.debugFailures.length = 0;
    this.pausedWork = Promise.resolve();
    this.evidence.length = 0;
    const failures: unknown[] = [];
    let baseline: Baseline | undefined;
    let initialIdentities: Identity[] = [];
    let finalReceipts: Readback | undefined;
    try {
      await this.main.getByTestId('chat-workspace-host').waitFor({ state: 'visible', timeout });
      await this.sessions.waitFor({ state: 'visible', timeout });
      if (await this.main.getByRole('dialog').or(this.main.getByRole('alertdialog')).count()) throw new Error('Race requires a Chat without pending dialogs');
      await this.chooseAgent();
      baseline = await this.remember();
      initialIdentities = await this.catalog();
      await this.install();
      const baseUrl = (await this.site.prepare()).baseUrl;
      let b: { page: BrowserPage; title: string; identity: Identity } | undefined;
      if (caseId === 12) {
        await this.newDraft();
        await this.expectCreate('B');
        await this.send();
        const identity = await this.created('B');
        await this.finishSend(identity);
        const title = `${this.owner}-B`;
        await this.renameCurrent(title);
        await this.arm('B', false);
        await this.launch();
        const page = await this.opened('B', false);
        await this.assertPresented(page);
        await this.navigate(page, `${baseUrl}/#${this.owner}-B`);
        await this.mark('B-baseline', { identity, pageId: page.pageId, title });
        b = { page, title, identity };
      }
      await this.newDraft();
      await this.arm('A', caseId !== 11);
      await this.launch();
      const a = await this.opened('A', caseId !== 11);
      await this.assertPresented(a);
      await this.navigate(a, `${baseUrl}/#${this.owner}-A`);
      await this.mark('A-open-presented', { pageId: a.pageId, webContentsId: a.webContentsId, pane: a.pane,
        url: a.url, documentToken: a.documentToken, text: a.text });
      if (caseId !== 11) await this.assertHeld('A');
      await this.expectCreate('A');
      await this.send();
      const identity = await this.created('A');
      const promotion = await this.promotion(a, identity);
      if (caseId !== 11) await this.assertHeld('A');
      await this.finishSend(identity);
      const aTitle = `${this.owner}-A`;
      if (caseId === 12) {
        await this.renameCurrent(aTitle);
        if (!b) throw new Error('B baseline is missing');
        await this.selectSession(b.title);
        await this.assertPresented(b.page);
        await this.mark('B-selected-before-release', { identity: b.identity, pageId: b.page.pageId });
      }
      if (caseId !== 11) await this.release();
      await this.promoted(a, promotion);
      if (caseId === 12) {
        if (!b) throw new Error('B baseline is missing');
        await this.assertCurrentTitle(b.title);
        await this.assertPresented(b.page);
        const snapshot = await this.snapshot();
        if (snapshot.views.some(view => view.tabId === a.tabId) || await this.tab(a.pageId).count() !== 0) {
          throw new Error('A late open was projected into B; no target-tab rescue click is allowed');
        }
        await this.mark('B-preserved-after-A-settled', { pageId: b.page.pageId, native: snapshot });
        await this.selectSession(aTitle);
        await this.assertPresented(a);
        await this.mark('A-returned-same-document', { pageId: a.pageId, webContentsId: a.webContentsId,
          url: a.url, pane: a.pane, text: a.text, documentToken: a.documentToken });
      } else {
        await this.assertPresented(a);
      }
      await this.load(identity);
      finalReceipts = await this.read();
      this.assertOrder(caseId, finalReceipts, a);
      await this.capture('final');
      if (caseId !== 12) await this.renameCurrent(aTitle);
    } catch (error) {
      failures.push(error);
      try { await this.capture('failure'); } catch (captureError) { failures.push(captureError); }
    } finally {
      const debugErrors = this.debugFailures.splice(0);
      if (this.installed) {
        try { await this.release(); } catch (error) { failures.push(error); }
        try { await this.cleanup(initialIdentities, baseline); } catch (error) { failures.push(error); }
        try { finalReceipts = await this.read(); } catch (error) { failures.push(error); }
      }
      this.debugFailures.push(...debugErrors);
      if (this.installed || this.cdp) {
        try { await this.dispose(); } catch (error) { failures.push(error); }
      }
      try {
        await writeFile(join(this.electron.outputDirectory, `${this.owner}.json`), JSON.stringify({
          caseId, iteration, outcome: failures.length ? 'failed' : 'passed',
          boundaries: 'UI draft/open/send; original IPC results only; gate delivery is not business-consumer completion; promotion command proves pending opening settled',
          evidence: this.evidence, transport: finalReceipts, failures: failures.map(error => this.describe(error)),
        }, null, 2));
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `IAB race ${caseId} iteration ${iteration} or cleanup failed`);
    return true;
  }

  private async install(): Promise<void> {
    const descriptor = await this.main.evaluate(installHarness, { owner: this.owner, mode: 'root' as const });
    this.evidence.push({ stage: 'actual Electron root descriptor', detail: descriptor });
    if (descriptor.configurable) this.installed = true;
    else await this.installCdp();
  }

  private async installCdp(): Promise<void> {
    const browser = await this.electron.connectBrowser();
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed() && page.url() === this.main.url());
    if (pages.length !== 1) throw new Error('CDP race gate requires the unique existing primary Renderer');
    const client = await pages[0].context().newCDPSession(pages[0]);
    this.cdp = client;
    const scripts: { scriptId: string; url: string; executionContextId: number }[] = [];
    client.on('Debugger.scriptParsed', script => { scripts.push(script); });
    client.on('Debugger.paused', event => {
      this.pausedWork = this.pausedWork.then(async () => {
        try {
          const frame = event.callFrames[0];
          const point = this.debugPoints.find(point => event.hitBreakpoints?.includes(point.id));
          if (!point) throw new Error('Unexpected debugger pause during IAB race');
          if (!frame.returnValue?.objectId || frame.returnValue.subtype !== 'promise') throw new Error('Preload invoke return breakpoint did not expose the original native Promise');
          const argumentsResult = await client.send('Debugger.evaluateOnCallFrame', {
            callFrameId: frame.callFrameId, expression: `[${point.channel},${point.args}]`, returnByValue: true, silent: true,
          });
          if (argumentsResult.exceptionDetails || !Array.isArray(argumentsResult.result.value)) throw new Error('Cannot read actual preload invoke arguments at its return point');
          const [channel, args] = argumentsResult.result.value as [string, unknown[]];
          const chained = await client.send('Runtime.callFunctionOn', {
            objectId: frame.returnValue.objectId,
            functionDeclaration: 'function(channel,args,owner){const state=window.__iabWorkspaceRace;if(!state||state.owner!==owner)throw new Error("Race observer missing");return state.track(channel,args,this)}',
            arguments: [{ value: channel }, { value: args }, { value: this.owner }], awaitPromise: false, returnByValue: false, silent: true,
          });
          if (chained.exceptionDetails || !chained.result.objectId || chained.result.subtype !== 'promise') throw new Error('CDP could not chain the original native Promise');
          await client.send('Debugger.setReturnValue', { newValue: { objectId: chained.result.objectId } });
        } catch (error) { this.debugFailures.push(error); }
        finally {
          try { await client.send('Debugger.resume'); } catch (error) { this.debugFailures.push(error); }
        }
      });
    });
    await client.send('Runtime.enable');
    await client.send('Debugger.enable');
    const candidates: { scriptId: string; context: number; source: string; match: RegExpMatchArray }[] = [];
    for (const script of scripts.filter(script => /(?:preload|electron)/i.test(script.url))) {
      const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId: script.scriptId });
      if (!scriptSource.includes('Invalid IPC channel:') || !/exposeInMainWorld\s*\(\s*['"]electron['"]/.test(scriptSource)) continue;
      for (const match of scriptSource.matchAll(/\binvoke\s*:\s*\(([^)]*)\)\s*=>\s*\{/g)) {
        if (/^\s*([\w$]+)\s*,\s*\.\.\.([\w$]+)\s*$/.test(match[1])) candidates.push({ scriptId: script.scriptId, context: script.executionContextId, source: scriptSource, match });
      }
    }
    if (candidates.length !== 1) throw new Error(`CDP gate unavailable: actual preload source has ${candidates.length} identifiable invoke functions`);
    const candidate = candidates[0];
    this.cdpContext = candidate.context;
    const installed = await client.send('Runtime.evaluate', { expression: `(${installHarness.toString()})(${JSON.stringify({ owner: this.owner, mode: 'cdp' })})`, contextId: candidate.context, returnByValue: true });
    if (installed.exceptionDetails) throw new Error('CDP could not install the owned observer in the actual preload world');
    this.installed = true;
    const offset = candidate.match.index! + candidate.match[0].length;
    const preceding = candidate.source.slice(0, offset).split('\n');
    const start = { scriptId: candidate.scriptId, lineNumber: preceding.length - 1, columnNumber: preceding[preceding.length - 1].length };
    const { locations } = await client.send('Debugger.getPossibleBreakpoints', { start, restrictToFunction: true });
    const parameters = candidate.match[1].match(/^\s*([\w$]+)\s*,\s*\.\.\.([\w$]+)\s*$/)!;
    const returns = locations.filter(location => location.type === 'return');
    if (!returns.length) throw new Error('CDP gate unavailable: actual preload invoke has no supported return breakpoint');
    for (const location of returns) {
      const channel = parameters[1];
      const request = `${parameters[2]}[0]`;
      const condition = `(${channel} === 'iab:command' && ['open','promote-display-scope'].includes(${request}?.command?.action)) || (${channel} === 'hostapi:fetch' && ${request}?.path === '/api/capabilities/execute' && String(${request}?.body).includes('"sessions.create"'))`;
      const result = await client.send('Debugger.setBreakpoint', { location, condition });
      this.breakpoints.push(result.breakpointId);
      this.debugPoints.push({ id: result.breakpointId, channel: parameters[1], args: parameters[2] });
    }
    this.evidence.push({ stage: 'CDP gate installed at actual preload return locations', detail: { scriptId: candidate.scriptId, locations: returns } });
  }

  private readonly debugPoints: { id: string; channel: string; args: string }[] = [];

  private async harness(input: Omit<HarnessOperation, 'owner'>): Promise<Readback | undefined> {
    if (this.debugFailures.length) throw new AggregateError(this.debugFailures, 'CDP race gate failed; actual order is unproven');
    const request = { owner: this.owner, ...input };
    if (!this.cdp) return this.main.evaluate(operateHarness, request);
    if (this.cdpContext === undefined) throw new Error('CDP preload context is unavailable');
    const response = await this.cdp.send('Runtime.evaluate', { expression: `(${operateHarness.toString()})(${JSON.stringify(request)})`, contextId: this.cdpContext, returnByValue: true });
    if (response.exceptionDetails) throw new Error(`Preload race observer operation failed: ${input.operation}`);
    return response.result.value as Readback | undefined;
  }

  private async read(): Promise<Readback> {
    return (await this.harness({ operation: 'read' }))!;
  }

  private async mark(stage: string, detail?: unknown): Promise<void> {
    await this.harness({ operation: 'mark', stage, detail });
  }

  private async arm(label: string, hold: boolean): Promise<void> {
    await this.harness({ operation: 'arm', label, hold });
  }

  private async expectCreate(label: string): Promise<void> {
    await this.harness({ operation: 'expectCreate', label });
  }

  private async release(): Promise<void> {
    // Cleanup must remain available even after a debugger failure.
    const errors = this.debugFailures.splice(0);
    try { await this.harness({ operation: 'release' }); } finally { this.debugFailures.push(...errors); }
  }

  private async dispose(): Promise<void> {
    const failures: unknown[] = [];
    const errors = this.debugFailures.splice(0);
    if (this.installed) {
      try { await this.harness({ operation: 'dispose' }); } catch (error) { failures.push(error); }
    }
    if (this.cdp) {
      await this.pausedWork;
      for (const breakpointId of this.breakpoints) {
        try { await this.cdp.send('Debugger.removeBreakpoint', { breakpointId }); } catch (error) { failures.push(error); }
      }
      try { await this.cdp.send('Debugger.disable'); } catch (error) { failures.push(error); }
      try { await this.cdp.detach(); } catch (error) { failures.push(error); }
    }
    this.installed = false;
    this.cdp = undefined;
    this.cdpContext = undefined;
    this.breakpoints.length = 0;
    this.debugPoints.length = 0;
    failures.push(...errors, ...this.debugFailures.splice(0));
    if (failures.length) throw new AggregateError(failures, 'IAB race observer and debugger cleanup failed');
  }

  private async chooseAgent(): Promise<void> {
    const headers = this.sessions.locator('button[aria-controls][title^="OpenClaw / "]');
    await headers.first().waitFor({ state: 'visible', timeout });
    const main = headers.filter({ hasText: /^main$/i });
    const chosen = await main.count() === 1 ? main : headers;
    if (await chosen.count() !== 1) throw new Error('A unique existing OpenClaw main Agent is required; no Agent or model configuration was changed');
    this.agentTitle = (await chosen.getAttribute('title'))!;
  }

  private async remember(): Promise<Baseline> {
    const selected = this.sessions.locator('button[title][aria-current="true"]');
    if (await selected.count() > 1) throw new Error('Multiple current sessions at race baseline');
    const composer = this.main.getByTestId('chat-composer-input');
    if (await selected.count() === 0 && (await composer.inputValue()).trim()) throw new Error('Existing unsent draft must be preserved; use an empty draft or an existing Session as the race baseline');
    const sessionGroup = await selected.count() ? await selected.evaluate(element => element.closest('section')?.querySelector('button[aria-controls][title]')?.getAttribute('title') ?? null) : null;
    const pageId = async (pane: 'main' | 'side') => {
      const tabs = this.main.locator(`[data-workspace-pane="${pane}"] [role="tab"][aria-selected="true"]`);
      if (await tabs.count() > 1) throw new Error('Multiple selected pages at race baseline');
      return await tabs.count() ? tabs.getAttribute('data-page-id') : null;
    };
    const baseline = { sessionTitle: await selected.count() ? await selected.getAttribute('title') : null, sessionGroup,
      agentExpanded: await this.header().getAttribute('aria-expanded') === 'true', sideVisible: await this.side.isVisible(),
      fullscreen: await this.side.getByRole('button', { name: /^(恢复工作区大小|Restore workspace)$/i }).count() > 0,
      selectedMain: await pageId('main'), selectedSide: await pageId('side'), native: await this.snapshot() };
    if (!baseline.sessionTitle && (baseline.selectedMain || baseline.selectedSide)) throw new Error('An existing draft with workspace pages cannot be restored through current UI; no race mutation was submitted');
    this.evidence.push({ stage: 'baseline', detail: baseline });
    return baseline;
  }

  private async newDraft(): Promise<void> {
    const button = this.group().getByRole('button', { name: /^(与.+新建会话|New session with .+)$/i });
    await button.focus({ timeout });
    await button.press('Enter', { timeout });
    await this.main.getByTestId('chat-composer-input').waitFor({ state: 'visible', timeout });
    await this.until(async () => await this.sessions.locator('button[title][aria-current="true"]').count() === 0, 'New Session UI did not select a draft');
    await this.expandSide();
  }

  private async expandSide(): Promise<void> {
    if (!await this.side.isVisible()) await this.main.getByRole('button', { name: /^(打开右侧栏|Open side panel)$/i }).click({ timeout });
    const restore = this.side.getByRole('button', { name: /^(恢复工作区大小|Restore workspace)$/i });
    if (await restore.count()) await restore.click({ timeout });
    await this.side.waitFor({ state: 'visible', timeout });
  }

  private async launch(): Promise<void> {
    await this.side.getByRole('button', { name: /^(打开页面|Open a page)$/i }).click({ timeout });
    await (await this.tools.overlay()).getByRole('menuitem', { name: /^(浏览器|Browser)$/i }).click({ timeout });
  }

  private async send(): Promise<void> {
    const composer = this.main.getByTestId('chat-composer-input');
    await composer.fill(prompt, { timeout });
    const send = this.main.locator('[data-chat-control="send"]');
    await this.until(() => send.isEnabled(), 'Existing Profile cannot send; no model, key or authorization was changed');
    await send.click({ timeout });
  }

  private async opened(label: string, held: boolean): Promise<BrowserPage> {
    let result: Open | undefined;
    await this.until(async () => {
      result = (await this.read()).opens.find(open => open.label === label && !!open.tabId);
      return !!result && (held ? result.held && !result.delivered : result.delivered);
    }, `${label} has no real native open response in the required delivery state`);
    const open = result!;
    const snapshot = await this.snapshot();
    const tab = snapshot.tabs.find(tab => tab.ownerId === open.ownerId && tab.id === open.tabId);
    if (!tab || snapshot.ownerId !== open.ownerId || tab.display.kind !== 'scope' || tab.display.scope !== open.scope || snapshot.revision < open.revision!) {
      throw new Error('Native snapshot did not independently confirm the exact draft open response');
    }
    this.evidence.push({ stage: `${label} native open independently read back`, detail: { open, snapshot } });
    return { ownerId: open.ownerId!, tabId: open.tabId!, pageId: `iab:${open.ownerId}:${open.tabId}`, scope: open.scope };
  }

  private async assertHeld(label: string): Promise<void> {
    const state = await this.read();
    const open = state.opens.find(open => open.label === label);
    if (!open?.held || open.delivered || !open.tabId || state.receipts.some(receipt => receipt.stage === 'open-delivered' && isRecord(receipt.detail) && receipt.detail.label === label)) {
      throw new Error(`${label} real open response was not still held; requested order was not exercised`);
    }
    await this.mark(`${label}-held-confirmed`, { tabId: open.tabId });
  }

  private async created(label: string): Promise<Identity> {
    let creation: Creation | undefined;
    await this.until(async () => {
      creation = (await this.read()).creates.find(create => create.label === label);
      if (creation?.failed) throw new Error(`${label} native Session create rejected or did not return a real SessionView; no retry`);
      return !!creation?.identity;
    }, `${label} UI send did not produce a native Session create response`);
    const identity = creation!.identity!;
    await this.load(identity);
    return identity;
  }

  private async promotion(page: BrowserPage, identity: Identity): Promise<string> {
    let target = '';
    await this.until(async () => {
      const event = (await this.read()).receipts.find(receipt => receipt.stage === 'session-promoted' && isRecord(receipt.detail)
        && JSON.stringify([receipt.detail.fromScopeKey, receipt.detail.draftId]) === page.scope);
      if (!event || !isRecord(event.detail) || typeof event.detail.toScopeKey !== 'string') return false;
      const key: unknown = JSON.parse(event.detail.toScopeKey);
      if (!isRecord(key) || key.agentId !== identity.agentId || key.sessionKey !== identity.sessionKey || !isRecord(key.endpoint)
        || key.endpoint.runtimeAdapterId !== identity.endpoint.runtimeAdapterId || key.endpoint.runtimeInstanceId !== identity.endpoint.runtimeInstanceId) {
        throw new Error('Workspace promotion does not identify this native-created Session');
      }
      target = event.detail.toScopeKey;
      return true;
    }, 'No real Workspace promotion event matched the original draft and created Session');
    return target;
  }

  private async promoted(page: BrowserPage, target: string): Promise<void> {
    await this.until(async () => {
      const state = await this.read();
      const response = state.receipts.find(receipt => receipt.stage === 'promotion-native-response' && isRecord(receipt.detail)
        && receipt.detail.from === page.scope && receipt.detail.to === target && receipt.detail.resultType === 'snapshot');
      const snapshot = await this.snapshot();
      const matches = snapshot.tabs.filter(tab => tab.ownerId === page.ownerId && tab.id === page.tabId);
      return !!response && snapshot.ownerId === page.ownerId && matches.length === 1
        && matches[0].display.kind === 'scope' && matches[0].display.scope === target;
    }, 'The same native tab was not promoted to its created Session after real opening consumption');
    await this.mark('A-promotion-readback', { ownerId: page.ownerId, tabId: page.tabId, target });
  }

  private async assertPresented(page: BrowserPage): Promise<void> {
    await this.until(async () => {
      const tab = this.tab(page.pageId);
      const snapshot = await this.snapshot();
      return snapshot.ownerId === page.ownerId && await tab.count() === 1 && await tab.getAttribute('aria-selected') === 'true'
        && await this.main.locator(`[data-iab-owner=${JSON.stringify(page.ownerId)}][data-iab-tab=${JSON.stringify(page.tabId)}][data-iab-visible="true"]`).isVisible()
        && snapshot.views.some(view => view.tabId === page.tabId && view.bounds.width > 0 && view.bounds.height > 0);
    }, 'Automatic presentation did not reveal the exact tab and native view; no rescue click was used');
    if (page.url) await this.assertNativePage(page);
  }

  private async navigate(page: BrowserPage, url: string): Promise<void> {
    const surface = this.main.locator('[data-browser-surface]:visible').filter({ has: this.main.locator(`[data-iab-tab=${JSON.stringify(page.tabId)}]`) });
    const address = surface.getByLabel(/^(搜索或输入网址|Search or enter a URL)$/i);
    await address.fill(url, { timeout });
    await address.press('Enter', { timeout });
    page.url = url;
    const browser = await this.electron.connectBrowser();
    await this.until(async () => {
      const matches = browser.contexts().flatMap(context => context.pages()).filter(candidate => !candidate.isClosed() && candidate.url() === url);
      return matches.length === 1 && await matches[0].getByRole('heading', { name: 'IAB E2E Home', exact: true }).isVisible();
    }, 'The real opened page did not finish navigation to its owned local content');
    const native = await this.electron.observeIabWebContents(url);
    if (native.length !== 1) throw new Error('Owned page has no unique native WebContents');
    page.webContentsId = native[0].webContentsId;
    page.pane = await this.tab(page.pageId).evaluate(element => element.closest('[data-workspace-pane]')?.getAttribute('data-workspace-pane') ?? undefined);
    if (page.pane !== 'main' && page.pane !== 'side') throw new Error('Owned page has no identifiable Workspace pane');
    const web = browser.contexts().flatMap(context => context.pages()).find(candidate => !candidate.isClosed() && candidate.url() === url)!;
    page.documentToken = `${this.owner}-${page.tabId}`;
    page.text = `${this.owner}-kept-${page.tabId}`;
    await web.evaluate(token => { (window as unknown as { __iabRaceDocument?: string }).__iabRaceDocument = token; }, page.documentToken);
    await web.locator('#text').fill(page.text);
    await web.locator('#apply').click();
    await this.assertNativePage(page);
  }

  private async assertNativePage(page: BrowserPage): Promise<void> {
    const browser = await this.electron.connectBrowser();
    await this.until(async () => {
      const native = await this.electron.observeIabWebContents(page.url!);
      if (native.length !== 1 || native[0].webContentsId !== page.webContentsId || !native[0].attached || !native[0].visible || !native[0].bounds) return false;
      const bounds = native[0].bounds;
      const content = native[0].contentBounds;
      if (bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0
        || bounds.x + bounds.width > content.width || bounds.y + bounds.height > content.height) return false;
      const tab = this.tab(page.pageId);
      if (await tab.count() !== 1 || await tab.evaluate(element => element.closest('[data-workspace-pane]')?.getAttribute('data-workspace-pane')) !== page.pane) return false;
      const slot = this.main.locator(`[data-iab-owner=${JSON.stringify(page.ownerId)}][data-iab-tab=${JSON.stringify(page.tabId)}][data-iab-visible="true"]:visible`);
      if (await slot.count() !== 1) return false;
      const rect = await slot.boundingBox();
      const view = (await this.snapshot()).views.find(view => view.tabId === page.tabId);
      if (!rect || !view) return false;
      const viewport = await this.main.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const scale = content.width / viewport.width;
      const close = (left: number, right: number) => Math.abs(left - right) <= 2;
      if (Math.abs(scale - content.height / viewport.height) >= 0.02
        || !close(bounds.x, rect.x * scale) || !close(bounds.y, rect.y * scale)
        || !close(bounds.width, rect.width * scale) || !close(bounds.height, rect.height * scale)
        || !close(view.bounds.x, rect.x) || !close(view.bounds.y, rect.y)
        || !close(view.bounds.width, rect.width) || !close(view.bounds.height, rect.height)) return false;
      const matches = browser.contexts().flatMap(context => context.pages()).filter(candidate => !candidate.isClosed() && candidate.url() === page.url);
      return matches.length === 1 && await matches[0].getByRole('heading', { name: 'IAB E2E Home', exact: true }).isVisible()
        && await matches[0].locator('#text').inputValue() === page.text && await matches[0].locator('#applied').textContent() === page.text
        && await matches[0].evaluate(() => (window as unknown as { __iabRaceDocument?: string }).__iabRaceDocument) === page.documentToken;
    }, 'Original document/URL/text/pane or in-window native/DOM/snapshot bounds changed; no target-tab rescue click was used');
  }

  private async finishSend(identity: Identity): Promise<void> {
    await this.until(async () => {
      const view = await this.load(identity);
      const items = this.facts(view.items);
      const runtime = this.facts(view.runtime);
      if (isRecord(runtime) && runtime.phase === 'failed') throw new Error('Real model send failed; no key/model change or resend was attempted');
      return Array.isArray(items) && items.some(item => isRecord(item) && item.kind === 'userMessage' && item.text === prompt)
        && isRecord(runtime) && runtime.phase !== 'idle';
    }, 'The single UI first-send prompt was not accepted into the native-created Session');
    const stop = this.main.locator('[data-chat-control="send"]');
    if (/^(停止|Stop)/i.test(await stop.getAttribute('aria-label') ?? '') && await stop.isEnabled()) await stop.click({ timeout });
    await this.until(async () => {
      const runtime = this.facts((await this.load(identity)).runtime);
      if (isRecord(runtime) && runtime.phase === 'failed') throw new Error('Real model send failed; no key/model change or resend was attempted');
      return isRecord(runtime) && runtime.activeRunId === null && ['completed', 'cancelled', 'interrupted'].includes(String(runtime.phase));
    }, 'The owned real send did not settle after normal UI Stop/completion');
  }

  private async renameCurrent(title: string): Promise<void> {
    const current = this.sessions.locator('button[title][aria-current="true"]');
    await current.waitFor({ state: 'visible', timeout });
    await current.hover({ timeout });
    await current.locator('..').locator('button[aria-label]').click({ timeout });
    await this.main.getByRole('menuitem', { name: /^(重命名|Rename)$/i }).click({ timeout });
    const dialog = this.main.getByRole('dialog');
    await dialog.getByRole('textbox').fill(title, { timeout });
    await dialog.getByRole('button', { name: /^(保存|Save)$/i }).click({ timeout });
    await this.until(async () => await this.main.getByRole('dialog').count() === 0, 'Owned Session rename dialog did not close');
    await this.assertCurrentTitle(title);
  }

  private async selectSession(title: string, groupTitle = this.agentTitle): Promise<void> {
    const header = this.header(groupTitle);
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click({ timeout });
    const row = this.group(groupTitle).locator(`button[title=${JSON.stringify(title)}]:not([aria-controls])`);
    if (await row.count() !== 1) throw new Error('Session UI target title is not unique; no ambiguous click was used');
    await row.click({ timeout });
    await this.assertCurrentTitle(title);
  }

  private async assertCurrentTitle(title: string): Promise<void> {
    await this.until(async () => {
      const current = this.sessions.locator('button[title][aria-current="true"]');
      return await current.count() === 1 && await current.getAttribute('title') === title;
    }, 'Late A result changed the current B Session');
  }

  private assertOrder(caseId: CaseId, state: Readback, page: BrowserPage): void {
    const find = (stage: string, match: (detail: Record<string, unknown>) => boolean = () => true) => {
      const receipt = state.receipts.find(receipt => receipt.stage === stage && isRecord(receipt.detail) && match(receipt.detail));
      if (!receipt) throw new Error(`Missing actual ordering receipt: ${stage}`);
      return receipt.seq;
    };
    const open = (stage: string) => find(stage, detail => detail.label === 'A');
    const created = find('create-native-response', detail => detail.label === 'A' && detail.failed === false);
    const promoted = find('session-promoted', detail => JSON.stringify([detail.fromScopeKey, detail.draftId]) === page.scope);
    const consumer = find('promotion-dispatched', detail => detail.from === page.scope);
    const presented = find('A-open-presented');
    const ordered = caseId === 11
      ? [open('open-dispatched'), open('open-native-response'), open('open-delivered'), presented, find('create-dispatched', detail => detail.label === 'A'), created, promoted, consumer]
      : caseId === 10
        ? [open('open-dispatched'), open('open-native-response'), presented, created, promoted, open('open-delivered'), consumer]
        : [find('B-baseline'), open('open-dispatched'), open('open-native-response'), presented, created, promoted, find('B-selected-before-release'), open('open-delivered'), consumer, find('A-promotion-readback'), find('B-preserved-after-A-settled'), find('A-returned-same-document')];
    if (!ordered.every((seq, index) => index === 0 || seq > ordered[index - 1])) throw new Error(`Actual case ${caseId} ordering was not exercised: ${ordered.join(' < ')}`);
    if (state.opens.filter(open => open.label === 'A').length !== 1 || state.creates.filter(create => create.label === 'A').length !== 1) {
      throw new Error('The race was replayed or produced ambiguous real operations');
    }
  }

  private async snapshot(): Promise<Snapshot> {
    return this.main.evaluate(async () => (window as unknown as HarnessWindow).electron.ipcRenderer.invoke('iab:snapshot') as Promise<Snapshot>);
  }

  private async capability(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.electron.fetchHostApi({ path: '/api/capabilities/execute', method: 'POST', body, timeoutMs: timeout });
    if (!reply.ok || !reply.data.ok || reply.data.status !== 200 || !isRecord(reply.data.json)) throw new Error('Real Session capability did not return a successful public response; no mutation replay');
    return reply.data.json;
  }

  private async catalog(): Promise<Identity[]> {
    const body = await this.capability({ id: 'session.management', operationId: 'sessions.list', scope: { kind: 'runtime-instance', endpoint },
      target: { kind: 'runtime-endpoint' }, input: { endpoint } });
    if (!Array.isArray(body.sessions)) throw new Error('Real Session catalog unavailable');
    return body.sessions.filter(isRecord).map(session => session.sessionIdentity).filter((identity): identity is Identity => isRecord(identity)
      && typeof identity.sessionKey === 'string' && typeof identity.agentId === 'string' && isRecord(identity.endpoint)
      && identity.endpoint.kind === endpoint.kind && identity.endpoint.runtimeAdapterId === endpoint.runtimeAdapterId && identity.endpoint.runtimeInstanceId === endpoint.runtimeInstanceId);
  }

  private request(identity: Identity, id: string, operationId: string, extra: Record<string, unknown> = {}) {
    return { id, operationId, scope: { kind: 'session', identity }, target: { kind: 'session', identity },
      input: { sessionIdentity: identity, sessionKey: identity.sessionKey, ...extra } };
  }

  private async load(identity: Identity): Promise<Record<string, unknown>> {
    const view = await this.capability(this.request(identity, 'session.management', 'sessions.load', { limit: 100 }));
    if (!isRecord(view.identity) || !isRecord(view.identity.endpoint) || !sameIdentity(view.identity as Identity, identity) || view.sessionKey !== identity.sessionKey) {
      throw new Error('Native Session load did not confirm the exact created identity');
    }
    return view;
  }

  private facts(value: unknown): unknown {
    return isRecord(value) ? Object.hasOwn(value, 'complete') ? value.complete : isRecord(value.incomplete) ? value.incomplete.facts : undefined : undefined;
  }

  private async cleanup(initial: Identity[], baseline?: Baseline): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (action: () => Promise<void>) => { try { await action(); } catch (error) { failures.push(error); } };
    await attempt(async () => { await this.until(async () => (await this.read()).opens.every(open => open.delivered), 'Released real open responses did not settle during cleanup'); });
    const state = await this.read();
    const owned = state.creates.filter(create => create.identity).map(create => ({ identity: create.identity!, title: `${this.owner}-${create.label}` }));
    for (const { identity } of owned) await attempt(async () => {
      if (initial.some(existing => sameIdentity(existing, identity))) throw new Error('Native create returned a preexisting Session; cleanup refuses to mutate it');
      const runtime = this.facts((await this.load(identity)).runtime);
      if (!isRecord(runtime)) throw new Error('Owned Session runtime unavailable; retain it rather than guessing cancellation ownership');
      if (typeof runtime.activeRunId === 'string') {
        const receipt = await this.capability(this.request(identity, 'session.prompt', 'sessions.abort', { runId: runtime.activeRunId }));
        if (receipt.outcome !== 'succeeded') throw new Error('Owned cleanup abort outcome unresolved; no replay');
        await this.until(async () => {
          const current = this.facts((await this.load(identity)).runtime);
          return isRecord(current) && current.activeRunId === null;
        }, 'Owned cleanup run did not stop');
      }
    });
    for (const open of state.opens) await attempt(async () => {
      const snapshot = await this.snapshot();
      const tabs = snapshot.tabs.filter(tab => open.tabId ? tab.id === open.tabId && tab.ownerId === open.ownerId
        : tab.display.kind === 'scope' && tab.display.scope === open.scope && !baseline?.native.tabs.some(old => old.ownerId === tab.ownerId && old.id === tab.id));
      for (const tab of tabs) {
        if (snapshot.ownerId !== tab.ownerId || baseline?.native.tabs.some(old => old.ownerId === tab.ownerId && old.id === tab.id)) throw new Error('Cleanup cannot establish owned native tab identity');
        const response = await this.main.evaluate(async tabId => (window as unknown as HarnessWindow).electron.ipcRenderer.invoke('iab:command', { command: { action: 'close', tabId } }), tab.id);
        if (!isRecord(response) || !isRecord(response.result) || response.result.resultType === 'error') throw new Error('Owned native tab close outcome unresolved; no replay');
        await this.until(async () => !(await this.snapshot()).tabs.some(current => current.ownerId === tab.ownerId && current.id === tab.id), 'Owned native tab remained after its single cleanup close');
      }
    });
    if (baseline) await attempt(async () => {
      if (baseline.sessionTitle && baseline.sessionGroup) await this.selectSession(baseline.sessionTitle, baseline.sessionGroup);
      else await this.newDraft();
    });
    for (const { identity, title } of owned) await attempt(async () => {
      if (initial.some(existing => sameIdentity(existing, identity))) throw new Error('Preexisting Session deletion refused');
      const runtime = this.facts((await this.load(identity)).runtime);
      if (!isRecord(runtime) || runtime.activeRunId !== null) throw new Error('Owned Session is not confirmed inactive; deletion refused');
      const listed = await this.capability({ id: 'session.management', operationId: 'sessions.list', scope: { kind: 'runtime-instance', endpoint },
        target: { kind: 'runtime-endpoint' }, input: { endpoint } });
      if (!Array.isArray(listed.sessions)) throw new Error('Native catalog unavailable; UI deletion refused');
      const matches = listed.sessions.filter(isRecord).filter(session => session.label === title);
      if (matches.length !== 1 || !isRecord(matches[0].sessionIdentity) || !isRecord(matches[0].sessionIdentity.endpoint)
        || !sameIdentity(matches[0].sessionIdentity as Identity, identity)) throw new Error('Owned UI title does not identify the exact native Session; deletion refused');
      if (await this.header().getAttribute('aria-expanded') !== 'true') await this.header().click({ timeout });
      const row = this.group().locator(`button[title=${JSON.stringify(title)}]:not([aria-controls])`);
      if (await row.count() !== 1) throw new Error('Owned Session UI row is not unique; deletion refused');
      await this.mark('cleanup-delete-target-confirmed', { identity, title });
      const menu = row.locator('..').locator('button[aria-label]');
      await menu.focus({ timeout });
      await menu.press('Enter', { timeout });
      await this.main.getByRole('menuitem', { name: /^(删除|Delete)$/i }).click({ timeout });
      const dialog = this.main.getByRole('dialog', { name: `删除 ${title}`, exact: true })
        .or(this.main.getByRole('dialog', { name: `Delete ${title}`, exact: true }));
      await dialog.getByRole('button', { name: /^(确认删除|Confirm Delete)$/i }).click({ timeout });
      await this.until(async () => await this.main.getByRole('dialog').count() === 0, 'Owned Session delete outcome unresolved; no replay or API fallback');
      await this.until(async () => await row.count() === 0, 'Owned Session remained in Renderer directory after UI deletion');
      await this.until(async () => !(await this.catalog()).some(current => sameIdentity(current, identity)), 'Exact owned Session remained in native catalog after UI deletion');
      await this.mark('cleanup-delete-confirmed', { identity, title, dialogCount: 0, uiRowCount: 0, nativePresent: false });
    });
    if (baseline) await attempt(async () => {
      await this.expandSide();
      if (baseline.selectedSide) await this.tab(baseline.selectedSide).click({ timeout });
      if (baseline.selectedMain) await this.tab(baseline.selectedMain).click({ timeout });
      else await this.mainPane.getByRole('tab', { name: /^(聊天|Chat)$/i, exact: true }).click({ timeout });
      if (baseline.fullscreen) await this.side.getByRole('button', { name: /^(全屏|Full screen)$/i }).click({ timeout });
      if (!baseline.sideVisible) await this.side.getByRole('button', { name: /^(收起工作区|Collapse workspace)$/i }).click({ timeout });
      if (!baseline.agentExpanded && await this.header().getAttribute('aria-expanded') === 'true') await this.header().click({ timeout });
    });
    if (state.creates.some(create => !create.identity)) failures.push(new Error('A submitted native create has no confirmed identity; retained unknown result without replay or broad deletion'));
    if (failures.length) throw new AggregateError(failures, 'Race resource and UI cleanup failed');
  }

  private async capture(stage: string): Promise<void> {
    this.evidence.push({ stage, detail: { native: await this.snapshot() } });
    await this.desktop.capture(`${this.owner}-${stage}`);
  }

  private async until(condition: () => Promise<boolean>, message: string): Promise<void> {
    const deadline = Date.now() + timeout;
    do { if (await condition()) return; await delay(75); } while (Date.now() < deadline);
    throw new Error(message);
  }

  private describe(error: unknown): string {
    return error instanceof AggregateError ? `${error.message}: ${error.errors.map(item => this.describe(item)).join('; ')}`
      : error instanceof Error ? error.stack ?? error.message : String(error);
  }
}
