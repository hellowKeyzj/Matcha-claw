// @ts-expect-error Playwright ships this generated browser source without declarations; Vite bundles the string, not a browser connection.
import { source as injectedSource } from '../../../node_modules/playwright-core/lib/generated/injectedScriptSource.js';
import type { IabCdpExecutor, IabCdpEvent } from './contracts';
import type { BrowserSnapshotAction } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabJsonObject, IabJsonValue } from '../../../src/types/desktop/iab';
import { iabError } from './error';
import { captureFusedRows, degradedSnapshot } from './automation-snapshot';

export type Frame = { id: string; parentId?: string; name?: string; url: string; sessionId?: string; contextId: number; documentGeneration: number; helperReady?: boolean };
export type BackendTarget = { backendNodeId?: number; frameId?: string };
type ElementRef = { frame: Frame; backendNodeId: number; generation: number; identity?: string };
type ActiveRequest = { sessionId?: string; frameId?: string; loaderId?: string };
type FrameTree = { frame: { id: string; parentId?: string }; childFrames?: FrameTree[] };
const responseBodyLimit = 262144;
const responseBodyBudget = 1048576;
const networkBuffers = { maxResourceBufferSize: responseBodyLimit, maxTotalBufferSize: responseBodyBudget };
export type Operation = { signal: AbortSignal; deadline: number; assertCurrent?: () => void; onActionPerformed?: () => void; tasks?: Set<Promise<unknown>>; failures: unknown[] };
type RemoteResult = { result: { value?: any; objectId?: string; description?: string; subtype?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
const helperName = '__matchaIabAutomation';
const injectedExpression = `(() => { const module = {exports:{}}; ${injectedSource}\n; return new module.exports.InjectedScript(globalThis,{isUnderTest:false,sdkLanguage:'javascript',testIdAttributeName:'data-testid',stableRafCount:2,browserName:'chromium',customEngines:[],isUtilityWorld:true}); })()`;

export class IabAutomationPage {
  readonly messages: IabJsonObject[] = [];
  readonly errors: IabJsonObject[] = [];
  readonly requests: IabJsonObject[] = [];
  readonly events: IabJsonObject[] = [];
  readonly scripts = new Map<string, IabJsonObject>();
  private frames: Frame[] = [];
  private readonly refs = new Map<string, ElementRef>();
  private nextRef = 0;
  private nextRequest = 0;
  private documentGeneration = 0;
  private snapshotInput?: BrowserSnapshotAction;
  readonly settings: { pace?: { minIntervalMs: number; jitterMs?: number }; humanize?: boolean; stealth?: { enabled: boolean } } = {};
  lastActAt = 0;
  dialog: { accept: boolean; promptText?: string } | null = null;
  operation?: Operation;
  private eventSequence = 0;
  private readonly networkEntries = new Map<string, IabJsonObject>();
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly frameParents = new Map<string, string | undefined>();
  private readonly bodyTasks = new Set<Promise<unknown>>();
  private readonly bodyBudgets = new WeakMap<Operation, number>();
  private readonly retainedBodies = new Map<IabJsonObject, number>();
  private retainedBodyBytes = 0;
  private readonly eventTasks = new Set<Promise<unknown>>();
  private readonly defaultContexts = new Map<string, { id: number; sessionId?: string }>();
  private readonly objectSessions = new Set<string | undefined>();
  private readonly stopEvents: () => void;

  readonly assertCurrent = (): void => {
    const operation = this.operation;
    if (!operation?.assertCurrent) throw iabError('IAB_OPERATION_REQUIRED', 'A current verified browser invocation is required for native effects');
    operation.signal.throwIfAborted(); operation.assertCurrent();
    if (operation.deadline <= Date.now()) throw iabError('IAB_TIMEOUT', 'Browser operation timed out');
  };

  constructor(readonly executor: IabCdpExecutor) {
    this.stopEvents = executor.onEvent((event) => this.receive(event));
  }

  dispose(): void { this.stopEvents(); this.invalidateRefs(); this.resetNetwork(); }
  invalidateRefs(): void { this.documentGeneration++; this.frames = []; }

  async refreshChangedRefs(refs: (string | undefined)[], operation: Operation): Promise<IabJsonObject | undefined> {
    if (!refs.some((ref) => { const entry = ref ? this.refs.get(ref) : undefined; return entry && entry.generation !== this.documentGeneration; })) return;
    return this.updatedSnapshot('document_changed', operation);
  }

  async updatedSnapshot(reason: string, operation: Operation): Promise<IabJsonObject> {
    const snapshot = await this.snapshot(this.snapshotInput ?? { action: 'snapshot' }, operation);
    return { actionPerformed: false, pageUpdated: true, reason, ...(snapshot.degraded ? {} : { snapshot: snapshot.snapshot, refs: snapshot.refs, frames: snapshot.frames, pageUrl: await this.evaluate('location.href', operation) }) };
  }

  domSignature(operation: Operation): Promise<string> {
    return this.evaluate(`[document.getElementsByTagName('*').length,document.documentElement.scrollHeight,document.body?.lastElementChild?document.body.lastElementChild.tagName+'|'+(document.body.lastElementChild.id||'')+'|'+String(document.body.lastElementChild.className||'').slice(0,80):''].join('#')`, operation);
  }

  send<T = IabJsonObject>(method: string, params: IabJsonObject | undefined, operation: Operation, sessionId?: string): Promise<T> {
    operation.signal.throwIfAborted();
    const timeoutMs = operation.deadline - Date.now();
    if (timeoutMs <= 0) throw iabError('IAB_TIMEOUT', 'Browser operation timed out');
    const assertCurrent = operation.assertCurrent ?? this.assertCurrent;
    assertCurrent?.();
    return this.executor.send(method, params, { sessionId, signal: operation.signal, timeoutMs, assertCurrent }).then((result) => result as T);
  }

  async initialize(operation: Operation): Promise<void> {
    await this.send('Page.enable', undefined, operation);
    const recordFrames = (tree: FrameTree) => {
      if (!tree?.frame) return;
      this.frameParents.set(tree.frame.id, tree.frame.parentId);
      for (const child of tree.childFrames ?? []) recordFrames(child);
    };
    recordFrames((await this.send<{ frameTree: FrameTree }>('Page.getFrameTree', undefined, operation)).frameTree);
    await this.send('Runtime.enable', undefined, operation);
    await this.send('Network.enable', networkBuffers, operation);
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true }, operation);
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true }, operation);
  }

  async refreshFrames(operation: Operation, installHelper = true): Promise<Frame[]> {
    const generation = this.documentGeneration;
    const children = await this.executor.listChildFrames({ signal: operation.signal, timeoutMs: Math.max(1, operation.deadline - Date.now()), assertCurrent: operation.assertCurrent ?? this.assertCurrent });
    const descriptions = new Map<string, { id: string; parentId?: string; name?: string; url: string; sessionId?: string }>();
    const walk = (tree: any, sessionId?: string) => {
      if (!tree?.frame) return;
      const parentId = tree.frame.parentId ?? (sessionId ? this.frameParents.get(tree.frame.id) : undefined);
      descriptions.set(tree.frame.id, { ...tree.frame, parentId, sessionId });
      this.frameParents.set(tree.frame.id, parentId);
      for (const child of tree.childFrames ?? []) walk(child, sessionId);
    };
    walk((await this.send<any>('Page.getFrameTree', undefined, operation)).frameTree);
    for (const child of children) {
      walk((await this.send<any>('Page.getFrameTree', undefined, operation, child.sessionId)).frameTree, child.sessionId);
      await this.send('Runtime.enable', undefined, operation, child.sessionId);
      await this.send('Network.enable', networkBuffers, operation, child.sessionId);
    }
    const frames: Frame[] = [];
    for (const description of descriptions.values()) {
      const cached = this.frames.find((frame) => frame.id === description.id && frame.url === description.url && frame.sessionId === description.sessionId && frame.documentGeneration === generation);
      let frame: Frame;
      if (cached) frame = { ...cached, ...description };
      else {
        const world = await this.send<any>('Page.createIsolatedWorld', { frameId: description.id, worldName: 'matcha-iab-automation', grantUniveralAccess: false }, operation, description.sessionId);
        frame = { ...description, contextId: world.executionContextId, documentGeneration: generation };
      }
      if (installHelper && !frame.helperReady) {
        await this.evaluate(`(() => {Object.defineProperty(globalThis,${JSON.stringify(helperName)},{value:${injectedExpression},configurable:true});return true;})()`, operation, frame);
        frame.helperReady = true;
      }
      frames.push(frame);
    }
    this.frames = frames;
    return frames;
  }

  async evaluateInFrame(expression: string, frameId: string | undefined, operation: Operation): Promise<any> {
    const frames = await this.refreshFrames(operation);
    const frame = frameId ? frames.find((candidate) => candidate.id === frameId) : undefined;
    if (frameId && !frame) throw iabError('IAB_FRAME_NOT_FOUND', `Frame not found: ${frameId}`);
    if (!frame) return this.evaluate(expression, operation);
    let context = this.defaultContexts.get(frame.id);
    if (!context) {
      await this.send('Runtime.disable', undefined, operation, frame.sessionId);
      await this.send('Runtime.enable', undefined, operation, frame.sessionId);
      context = this.defaultContexts.get(frame.id);
    }
    if (!context) throw iabError('IAB_FRAME_CONTEXT_UNAVAILABLE', 'Frame has no live default JavaScript context');
    return this.evaluate(expression, operation, { ...frame, contextId: context.id });
  }

  trackOperation(task: Promise<unknown>): void {
    const tasks = this.operation?.tasks;
    if (!tasks) return;
    tasks.add(task);
    const failures = this.operation?.failures;
    void task.then(() => tasks.delete(task), (error: unknown) => { failures?.push(error); tasks.delete(task); });
  }

  async settleEvents(operation: Operation): Promise<void> {
    while (this.eventTasks.size) { operation.signal.throwIfAborted(); await Promise.all([...this.eventTasks]); }
  }

  readRequests(filter?: string): IabJsonObject[] {
    const keyword = filter?.toLowerCase();
    return this.requests.slice(-500).filter((entry) => !keyword || String((entry.request as IabJsonObject | undefined)?.url ?? '').toLowerCase().includes(keyword)).map((entry) => {
      const request = entry.request as IabJsonObject | undefined;
      return { id: entry.id, timestamp: new Date(Number(entry.startedAt)).toISOString(), method: String(request?.method ?? ''), url: String(request?.url ?? ''), ...(typeof entry.type === 'string' ? { resourceType: entry.type } : {}), ...(typeof entry.status === 'number' ? { status: entry.status } : {}), ...(typeof entry.ok === 'boolean' ? { ok: entry.ok } : {}), ...(typeof entry.failureText === 'string' ? { failureText: entry.failureText } : {}) };
    });
  }

  async releaseObjects(operation: Operation): Promise<void> {
    const sessions = [...this.objectSessions];
    this.objectSessions.clear();
    const failures: unknown[] = [];
    for (const sessionId of sessions) {
      try { await this.send('Runtime.releaseObjectGroup', { objectGroup: 'matcha-iab-action' }, operation, sessionId); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Browser object cleanup failed', { cause: failures[0] });
  }

  async evaluate(expression: string, operation: Operation, frame?: Frame, returnByValue = true): Promise<any> {
    if (!returnByValue) this.objectSessions.add(frame?.sessionId);
    const response = await this.send<RemoteResult>('Runtime.evaluate', { expression, objectGroup: 'matcha-iab-action', ...(frame ? { contextId: frame.contextId } : {}), returnByValue, awaitPromise: true, userGesture: true }, operation, frame?.sessionId);
    if (response.exceptionDetails) throw iabError('IAB_EVALUATION_FAILED', response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Page evaluation failed');
    if (response.result.subtype === 'error') throw iabError('IAB_EVALUATION_FAILED', String(response.result.description ?? response.result.value ?? 'script threw'));
    return returnByValue ? response.result.value : response.result.objectId;
  }

  async snapshot(params: BrowserSnapshotAction, operation: Operation): Promise<IabJsonObject> {
    if ((params.snapshotFormat && params.snapshotFormat !== 'ai') || (params.refs && params.refs !== 'role')) throw iabError('IAB_SNAPSHOT_FORMAT_UNSUPPORTED', 'IAB snapshots use AI role text and role refs');
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) throw iabError('IAB_SNAPSHOT_LIMIT_INVALID', 'Snapshot limit must be a positive integer');
    if (params.maxChars !== undefined && (!Number.isInteger(params.maxChars) || params.maxChars < 1)) throw iabError('IAB_SNAPSHOT_LIMIT_INVALID', 'Snapshot maxChars must be a positive integer');
    try {
      try { return await this.snapshotAi(params, operation); }
      catch (error) {
        operation.signal.throwIfAborted(); operation.assertCurrent?.();
        if (!(error instanceof Error && 'code' in error && error.code === 'IAB_SNAPSHOT_DOCUMENT_CHANGED')) throw error;
        return await this.snapshotAi(params, operation);
      }
    } catch (error) {
      operation.signal.throwIfAborted();
      (operation.assertCurrent ?? this.assertCurrent)?.();
      if (error instanceof Error && 'code' in error && error.code === 'IAB_CDP_OUTCOME_UNKNOWN' || params.scope || params.frame || params.selector) throw error;
      const snapshot = await degradedSnapshot(this, params, error instanceof Error ? error.message : String(error), operation);
      return snapshot;
    }
  }

  private async snapshotAi(params: BrowserSnapshotAction, operation: Operation): Promise<IabJsonObject> {
    const generation = this.documentGeneration;
    const frames = await this.refreshFrames(operation);
    const frameScope = params.scope?.frame ?? params.frame;
    const selectedFrames = frameScope ? await this.selectFrames(frameScope, frames, operation) : frames;
    const rows = await captureFusedRows(this, selectedFrames, params, operation);
    if (generation !== this.documentGeneration) throw iabError('IAB_SNAPSHOT_DOCUMENT_CHANGED', 'Document changed while capturing the snapshot');
    const previousRefs = new Map([...this.refs].filter(([, entry]) => entry.identity && entry.generation === generation).map(([ref, entry]) => [entry.identity!, ref]));
    this.refs.clear();
    const refs: IabJsonObject = {};
    const lines = rows.map((row) => {
      if (!row.backendNodeId) return row.line;
      const identity = `${row.frame.id}\0${row.role}\0${row.name}\0${row.placeholder ?? ''}\0${row.nth ?? 0}`;
      const ref = previousRefs.get(identity) ?? `e${++this.nextRef}`;
      this.refs.set(ref, { frame: row.frame, backendNodeId: row.backendNodeId, generation, identity });
      refs[ref] = { ref, role: row.role ?? 'generic', name: row.name ?? '', backendNodeId: row.backendNodeId, frameId: row.frame.id, ...(row.placeholder ? { placeholder: row.placeholder } : {}), ...(row.nth ? { nth: row.nth } : {}) };
      return `${row.line} [ref=${ref}]`;
    });
    this.snapshotInput = params;
    let output = lines;
    if (params.depth !== undefined) output = output.filter((line) => (line.match(/^ */u)?.[0].length ?? 0) / 2 <= params.depth!);
    if (params.interactive || params.efficient || params.mode === 'efficient') output = output.filter((line) => /\[ref=/u.test(line) || /^- frame/u.test(line));
    if (params.compact) output = output.filter((line) => !/^\s*- (generic|group|none):?\s*$/u.test(line));
    const filter = params.filter;
    if (filter?.keywords?.length || filter?.roles?.length) {
      const keep = new Set<number>();
      let matches = 0;
      output.forEach((line, index) => {
        if (matches >= (filter.maxMatches ?? Infinity)) return;
        const role = /^\s*-\s+([^\s:[\]]+)/u.exec(line)?.[1];
        if (filter.roles?.length && (!role || !filter.roles.includes(role))) return;
        if (filter.keywords?.length && !filter.keywords.some((word) => line.toLowerCase().includes(word.toLowerCase()))) return;
        matches++;
        const context = filter.contextLines ?? 0;
        for (let cursor = Math.max(0, index - context); cursor <= Math.min(output.length - 1, index + context); cursor++) keep.add(cursor);
      });
      output = output.filter((_line, index) => keep.has(index));
    }
    const lineCount = output.length;
    if (params.limit !== undefined) output = output.slice(0, params.limit);
    const joined = output.join('\n');
    const snapshot = params.maxChars === undefined ? joined : joined.slice(0, params.maxChars);
    const visibleRefs = new Set([...snapshot.matchAll(/\[ref=(e\d+)\]/gu)].map((match) => match[1]));
    for (const ref of Object.keys(refs)) if (!visibleRefs.has(ref)) delete refs[ref];
    return { snapshot, refs, degraded: false, source: 'fused', stats: { lines: output.length, chars: snapshot.length, refs: Object.keys(refs).length, interactive: rows.filter((row) => row.interactive).length }, truncated: output.length < lineCount || snapshot.length < joined.length, frames: selectedFrames.map((frame) => ({ id: frame.id, name: frame.name ?? '', url: frame.url })) };
  }

  private async selectFrames(scope: string, frames: Frame[], operation: Operation): Promise<Frame[]> {
    const direct = frames.filter((frame) => frame.id === scope || frame.name === scope || frame.url === scope);
    if (direct.length) return direct;
    for (const parent of frames) {
      const objectId = await this.evaluate(`globalThis.${helperName}.querySelector(globalThis.${helperName}.parseSelector(${JSON.stringify(scope)}),document,true)`, operation, parent, false);
      if (!objectId) continue;
      const description = await this.send<any>('DOM.describeNode', { objectId }, operation, parent.sessionId);
      await this.send('Runtime.releaseObject', { objectId }, operation, parent.sessionId);
      const frameId = description.node?.frameId;
      if (frameId) return frames.filter((frame) => frame.id === frameId);
    }
    throw iabError('IAB_FRAME_NOT_FOUND', `Snapshot frame not found: ${scope}`);
  }

  async resolveElement(ref: string | undefined, selector: string | undefined, operation: Operation, target: BackendTarget = {}): Promise<{ frame: Frame; objectId: string }> {
    let frame: Frame;
    let expression: string;
    const entry = ref && target.backendNodeId === undefined ? this.refs.get(ref) : undefined;
    if (ref && target.backendNodeId === undefined && !entry) throw iabError('IAB_REF_STALE', `Element reference is stale or unknown: ${ref}; take a new snapshot`);
    if (entry && entry.generation !== this.documentGeneration) throw iabError('IAB_DOCUMENT_CHANGED', 'Document changed after the snapshot; input was not dispatched');
    const backendNodeId = target.backendNodeId ?? entry?.backendNodeId;
    if (backendNodeId !== undefined) {
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 1) throw iabError('IAB_BACKEND_NODE_INVALID', 'backendNodeId must be a positive integer');
      const frames = await this.refreshFrames(operation);
      if (entry && entry.generation !== this.documentGeneration) throw iabError('IAB_DOCUMENT_CHANGED', 'Document changed while resolving the snapshot ref; input was not dispatched');
      frame = target.frameId ? frames.find((candidate) => candidate.id === target.frameId)! : entry ? frames.find((candidate) => candidate.id === entry.frame.id)! : frames.find((candidate) => !candidate.parentId)!;
      if (!frame) throw iabError('IAB_FRAME_NOT_FOUND', 'Backend node frame is no longer live; take a new snapshot');
      return this.resolveBackendElement(frame, backendNodeId, operation);
    }
    if (!selector) throw iabError('IAB_ELEMENT_REQUIRED', 'An element ref, backendNodeId or selector is required');
    const frames = await this.refreshFrames(operation);
    frame = target.frameId ? frames.find((candidate) => candidate.id === target.frameId)! : frames[0];
    if (!frame) throw iabError('IAB_FRAME_NOT_FOUND', `Frame not found: ${target.frameId}`);
    expression = `globalThis.${helperName}.querySelector(globalThis.${helperName}.parseSelector(${JSON.stringify(selector)}),document,true)`;
    const objectId = await this.evaluate(expression, operation, frame, false);
    if (!objectId) throw iabError('IAB_ELEMENT_NOT_FOUND', 'Element is detached or not found; take a new snapshot');
    return { frame, objectId };
  }

  async resolveBackendElement(frame: Frame, backendNodeId: number, operation: Operation): Promise<{ frame: Frame; objectId: string }> {
    this.objectSessions.add(frame.sessionId);
    const result = await this.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId, executionContextId: frame.contextId, objectGroup: 'matcha-iab-action' }, operation, frame.sessionId);
    if (!result.object?.objectId) throw iabError('IAB_ELEMENT_NOT_FOUND', 'Backend node is detached; take a new snapshot');
    return { frame, objectId: result.object.objectId };
  }

  async callElement(element: { frame: Frame; objectId: string }, body: string, args: IabJsonValue[], operation: Operation): Promise<any> {
    const response = await this.send<RemoteResult>('Runtime.callFunctionOn', { objectId: element.objectId, functionDeclaration: `function(...args){const h=globalThis.${helperName};${body}}`, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true, userGesture: true }, operation, element.frame.sessionId);
    if (response.exceptionDetails) throw iabError('IAB_ELEMENT_ACTION_FAILED', response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Element action failed');
    return response.result.value;
  }

  async verifyPoint(point: { x: number; y: number; element: { frame: Frame; objectId: string }; localPoint: { x: number; y: number } }, operation: Operation): Promise<void> {
    const hit = await this.callElement(point.element, 'return h.expectHitTarget(args[0],this);', [point.localPoint], operation);
    const mapped = hit === 'done' ? await this.toRootPoint(point.element.frame, point.localPoint, operation) : undefined;
    if (!mapped || Math.abs(mapped.x - point.x) > 0.5 || Math.abs(mapped.y - point.y) > 0.5) throw iabError('IAB_TARGET_CHANGED_BEFORE_INPUT', 'Target moved or became obscured after hover; input was not dispatched');
  }

  async actionablePoint(ref: string | undefined, selector: string | undefined, operation: Operation, states = ['visible', 'enabled', 'stable'], target: BackendTarget = {}): Promise<{ x: number; y: number; element: { frame: Frame; objectId: string }; localPoint: { x: number; y: number } }> {
    let lastReason = 'element is not actionable';
    while (Date.now() < operation.deadline) {
      operation.signal.throwIfAborted();
      const element = await this.resolveElement(ref, selector, operation, target);
      const state = await this.callElement(element, 'return h.checkElementStates(this,args[0]);', [states], operation);
      if (state) { lastReason = typeof state === 'string' ? state : `missing ${state.missingState}`; await this.pause(50, operation); continue; }
      await this.send('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId }, operation, element.frame.sessionId);
      const quads = await this.send<any>('DOM.getContentQuads', { objectId: element.objectId }, operation, element.frame.sessionId);
      const localRect = await this.callElement(element, 'const r=this.getBoundingClientRect();return {x:r.x,y:r.y};', [], operation);
      const firstQuad = quads.quads?.[0] as number[] | undefined;
      const offset = firstQuad ? { x: Math.min(firstQuad[0], firstQuad[2], firstQuad[4], firstQuad[6]) - localRect.x, y: Math.min(firstQuad[1], firstQuad[3], firstQuad[5], firstQuad[7]) - localRect.y } : { x: 0, y: 0 };
      const viewport = await this.evaluate('({width:innerWidth,height:innerHeight})', operation, element.frame);
      for (const protocolQuad of quads.quads ?? []) {
        const quad = (protocolQuad as number[]).map((value, index) => value - (index % 2 ? offset.y : offset.x));
        const point = clipQuadCenter(quad, viewport.width, viewport.height);
        if (!point) continue;
        const target = await this.callElement(element, 'return h.expectHitTarget(args[0],this);', [point], operation);
        if (target !== 'done') { lastReason = target.hitTargetDescription ?? 'another element intercepts pointer events'; continue; }
        const mapped = await this.toRootPoint(element.frame, point, operation);
        if (mapped) return { ...mapped, element, localPoint: point };
        lastReason = 'an ancestor frame is obscured';
      }
      await this.send('Runtime.releaseObject', { objectId: element.objectId }, operation, element.frame.sessionId);
      await this.pause(50, operation);
    }
    throw iabError('IAB_ELEMENT_NOT_ACTIONABLE', `Element is not actionable: ${lastReason}`);
  }

  async captureScreenshot(options: { format: 'png' | 'jpeg'; quality?: number; clip?: IabJsonObject; fullPage?: boolean; scale?: 'css' | 'device' }, operation: Operation): Promise<string> {
    try {
      if (!options.clip) {
        operation.signal.throwIfAborted();
        const timeoutMs = operation.deadline - Date.now();
        if (timeoutMs <= 0) throw iabError('IAB_TIMEOUT', 'Browser operation timed out');
        await this.executor.setScreenshotViewport({ signal: operation.signal, timeoutMs, assertCurrent: operation.assertCurrent });
      }
      let clip = options.clip;
      if (!clip) {
        const metrics = await this.send<{ cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number }; cssVisualViewport?: { pageX: number; pageY: number }; visualViewport: { pageX: number; pageY: number }; cssLayoutViewport?: { clientWidth: number; clientHeight: number }; layoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', undefined, operation);
        if (options.fullPage) {
          const size = metrics.cssContentSize ?? metrics.contentSize;
          if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw iabError('IAB_SCREENSHOT_DIMENSIONS_INVALID', 'Full-page screenshot requires valid document dimensions');
          clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height) };
        } else {
          const visual = metrics.cssVisualViewport ?? metrics.visualViewport;
          const layout = metrics.cssLayoutViewport ?? metrics.layoutViewport;
          clip = { x: Math.round(visual.pageX), y: Math.round(visual.pageY), width: Math.round(layout.clientWidth), height: Math.round(layout.clientHeight) };
        }
      }
      const result = await this.send<{ data: string }>('Page.captureScreenshot', { format: options.format, ...(options.quality === undefined ? {} : { quality: options.quality }), fromSurface: true, captureBeyondViewport: true, clip: { ...clip, scale: options.scale === 'css' ? 1 / await this.evaluate('devicePixelRatio', operation) : 1 } }, operation);
      return result.data;
    } finally {
      if (!options.clip) {
        try { await this.executor.restoreScreenshotViewport(operation.signal); }
        catch (error) { operation.failures.push(error); }
      }
    }
  }

  async elementClip(ref: string | undefined, selector: string | undefined, operation: Operation): Promise<IabJsonObject> {
    const element = await this.resolveElement(ref, selector, operation);
    await this.send('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId }, operation, element.frame.sessionId);
    const state = await this.callElement(element, 'return h.checkElementStates(this,["visible","stable"]);', [], operation);
    if (state) throw iabError('IAB_SCREENSHOT_ELEMENT_NOT_VISIBLE', 'Screenshot element must be visible and stable');
    const rect = await this.callElement(element, 'const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};', [], operation);
    const corners = await Promise.all([[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]].map(([x, y]) => this.toRootPoint(element.frame, { x, y }, operation, false)));
    const points = corners.filter((point): point is { x: number; y: number } => !!point);
    if (points.length !== 4) throw iabError('IAB_FRAME_CHANGED', 'Screenshot frame changed');
    const scroll = await this.evaluate('({x:scrollX,y:scrollY})', operation);
    const x = Math.min(...points.map((point) => point.x)), y = Math.min(...points.map((point) => point.y));
    return { x: x + scroll.x, y: y + scroll.y, width: Math.max(...points.map((point) => point.x)) - x, height: Math.max(...points.map((point) => point.y)) - y, scale: 1 };
  }

  async toRootPoint(frame: Frame, point: { x: number; y: number }, operation: Operation, checkHit = true): Promise<{ x: number; y: number } | undefined> {
    return (await this.toRootPoints(frame, [point], operation, checkHit, true))[0] ?? undefined;
  }

  async toRootPoints(frame: Frame, points: ({ x: number; y: number } | null)[], operation: Operation, checkHit = true, scrollFrame = false): Promise<({ x: number; y: number } | null)[]> {
    if (!frame.parentId) return points;
    const parent = this.frames.find((candidate) => candidate.id === frame.parentId);
    if (!parent) throw iabError('IAB_FRAME_CHANGED', 'Parent frame changed; take a new snapshot');
    const owner = await this.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame.id }, operation, parent.sessionId);
    if (scrollFrame) await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: owner.backendNodeId }, operation, parent.sessionId);
    const model = await this.send<{ model: { border: number[]; content: number[] } }>('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, operation, parent.sessionId);
    const viewport = await this.evaluate('({width:innerWidth,height:innerHeight})', operation, frame);
    const ownerElement = await this.resolveBackendElement(parent, owner.backendNodeId, operation);
    const local = await this.callElement(ownerElement, 'const r=this.getBoundingClientRect();return {x:r.x,y:r.y};', [], operation);
    const border = model.model.border;
    const offsetX = Math.min(border[0], border[2], border[4], border[6]) - local.x;
    const offsetY = Math.min(border[1], border[3], border[5], border[7]) - local.y;
    const quad = model.model.content.map((value, index) => value - (index % 2 ? offsetY : offsetX));
    let mapped = points.map((point) => point ? mapQuadPoint(quad, point.x / viewport.width, point.y / viewport.height) : null);
    if (checkHit) mapped = await this.callElement(ownerElement, 'return args[0].map(point=>point&&h.expectHitTarget(point,this)==="done"?point:null);', [mapped], operation);
    await this.send('Runtime.releaseObject', { objectId: ownerElement.objectId }, operation, parent.sessionId);
    return this.toRootPoints(parent, mapped, operation, checkHit, scrollFrame);
  }

  async pause(timeMs: number, operation: Operation): Promise<void> {
    operation.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); operation.signal.removeEventListener('abort', abort); reject(operation.signal.reason); };
      const timer = setTimeout(() => { operation.signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, Math.min(timeMs, operation.deadline - Date.now())));
      operation.signal.addEventListener('abort', abort, { once: true });
      if (operation.signal.aborted) abort();
    });
  }

  async wait(condition: { timeMs?: number; text?: string; textGone?: string; selector?: string; url?: string; loadState?: string; fn?: string }, operation: Operation): Promise<void> {
    if (condition.timeMs !== undefined && (!Number.isFinite(condition.timeMs) || condition.timeMs < 0)) throw iabError('IAB_WAIT_TIME_INVALID', 'Wait time must be nonnegative and finite');
    if (condition.timeMs && condition.timeMs > 0) { await this.pause(condition.timeMs, operation); return; }
    if (condition.loadState && !['load', 'domcontentloaded', 'networkidle'].includes(condition.loadState)) throw iabError('IAB_LOAD_STATE_INVALID', 'Unsupported wait loadState');
    if (condition.loadState === 'networkidle') {
      const pending = new Set<string>();
      let changedAt: number;
      const stop = this.executor.onEvent((event) => {
        if (!['Network.requestWillBeSent', 'Network.loadingFinished', 'Network.loadingFailed'].includes(event.method)) return;
        const requestId = typeof event.params.requestId === 'string' ? event.params.requestId : '';
        const key = `${event.sessionId ?? ''}\0${requestId}`;
        if (requestId) { if (event.method === 'Network.requestWillBeSent') pending.add(key); else pending.delete(key); }
        changedAt = Date.now();
      });
      try {
        await this.send('Network.enable', networkBuffers, operation);
        changedAt = Date.now();
        while (Date.now() < operation.deadline) {
          operation.signal.throwIfAborted(); operation.assertCurrent?.();
          if (!pending.size && Date.now() - changedAt >= 500) return;
          await this.pause(50, operation);
        }
        throw iabError('IAB_WAIT_TIMEOUT', 'Browser network did not become idle before the timeout');
      } finally { stop(); }
    }
    const predicate = condition.loadState ? `${condition.loadState === 'domcontentloaded' ? "['interactive','complete']" : "['complete']"}.includes(document.readyState)`
      : condition.text ? `(document.body?.innerText||'').includes(${JSON.stringify(condition.text)})`
      : condition.textGone ? `!(document.body?.innerText||'').includes(${JSON.stringify(condition.textGone)})`
      : condition.selector ? `document.querySelector(${JSON.stringify(condition.selector)})!==null`
      : condition.url ? `location.href.includes(${JSON.stringify(condition.url)})`
      : condition.fn ? `!!(${condition.fn})` : undefined;
    if (!predicate) throw iabError('IAB_WAIT_CONDITION_REQUIRED', 'Wait requires at least one condition');
    while (Date.now() < operation.deadline) {
      let response: RemoteResult | undefined;
      try { response = await this.send<RemoteResult>('Runtime.evaluate', { expression: predicate, returnByValue: true }, operation); }
      catch (error) {
        operation.signal.throwIfAborted(); (operation.assertCurrent ?? this.assertCurrent)();
        if (Date.now() >= operation.deadline || error instanceof Error && 'code' in error && String(error.code).startsWith('IAB_')) throw error;
      }
      if (response?.exceptionDetails) throw iabError('IAB_WAIT_PREDICATE_FAILED', response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Browser wait predicate threw');
      if (response?.result.value === true) return;
      await this.pause(200, operation);
    }
    throw iabError('IAB_WAIT_TIMEOUT', 'Browser wait condition was not satisfied before the timeout');
  }

  private resetNetwork(): void {
    this.activeRequests.clear();
    this.networkEntries.clear();
    this.frameParents.clear();  }

  private forgetNetworkRequests(matches: (request: ActiveRequest) => boolean): void {
    for (const [key, request] of this.activeRequests) if (matches(request)) this.activeRequests.delete(key);
    for (const [key, entry] of this.networkEntries) if (matches(entry as ActiveRequest)) this.networkEntries.delete(key);  }

  private frameBranch(frameId: string): Set<string> {
    const branch = new Set([frameId]);
    for (const id of branch) for (const [child, parent] of this.frameParents) if (parent === id) branch.add(child);
    return branch;
  }

  private collectResponseBody(key: string, entry: IabJsonObject, requestId: string, sessionId: string | undefined, operation: Operation): void {
    const omitted = (reason: string) => { entry.bodyError = reason; entry.bodyTruncated = true; };
    if (Math.max(Number(entry.decodedDataLength ?? 0), Number(entry.encodedDataLength ?? 0)) > responseBodyLimit) { omitted('Response body exceeds the 262144-byte capture limit'); return; }
    if (this.bodyTasks.size >= 2) { omitted('Response body capture concurrency limit reached'); return; }
    const reserved = this.bodyBudgets.get(operation) ?? 0;
    if (reserved + responseBodyLimit > responseBodyBudget) { omitted('Response body operation capture budget exhausted'); return; }
    // Reserve the native per-resource ceiling before dispatch; no unbounded body queue.
    this.bodyBudgets.set(operation, reserved + responseBodyLimit);
    const task = (async () => {
      try {
        const body = await this.send<IabJsonObject>('Network.getResponseBody', { requestId }, { ...operation, deadline: Math.min(operation.deadline, Date.now() + 5000) }, sessionId);
        operation.signal.throwIfAborted(); operation.assertCurrent?.();
        if (this.networkEntries.get(key) !== entry) { omitted('Response body is no longer in the current network capture'); return; }
        const bytes = Buffer.from(String(body.body ?? ''));
        let end = Math.min(bytes.length, responseBodyLimit);
        if (body.base64Encoded) end -= end % 4;
        else if (end < bytes.length) while ((bytes[end] & 0xc0) === 0x80) end--;
        while (this.retainedBodyBytes + end > responseBodyBudget || this.retainedBodies.size >= 1000) {
          const [previous, size] = this.retainedBodies.entries().next().value!;
          this.retainedBodies.delete(previous); this.retainedBodyBytes -= size;
          delete previous.body; delete previous.base64Encoded;
          previous.bodyError = 'Response body evicted from the 1048576-byte retained capture budget'; previous.bodyTruncated = true;
        }
        entry.body = bytes.subarray(0, end).toString();
        entry.base64Encoded = body.base64Encoded ?? false;
        entry.bodyTruncated = end < bytes.length;
        this.retainedBodies.set(entry, end); this.retainedBodyBytes += end;
      } catch (error) {
        operation.signal.throwIfAborted(); operation.assertCurrent?.();
        if (error instanceof Error && 'code' in error && String(error.code).startsWith('IAB_')) throw error;
        entry.bodyError = error instanceof Error ? error.message : String(error);
      }
    })().finally(() => { this.bodyTasks.delete(task); this.eventTasks.delete(task); });
    this.bodyTasks.add(task); this.eventTasks.add(task); this.trackOperation(task);
  }

  private receive(event: IabCdpEvent): void {
    const params = event.params;
    const operation = this.operation;
    let canDispatch = false;
    try { operation?.signal.throwIfAborted(); operation?.assertCurrent?.(); canDispatch = !!operation?.assertCurrent && operation.deadline > Date.now(); } catch { /* Observations persist, but revoked invocations cannot cause native effects. */ }
    if (event.method === 'Runtime.executionContextCreated') {
      const context = params.context as any;
      if (context?.auxData?.isDefault && typeof context.auxData.frameId === 'string') this.defaultContexts.set(context.auxData.frameId, { id: context.id, sessionId: event.sessionId });
    }
    if (event.method === 'Runtime.executionContextDestroyed') {
      for (const [frameId, context] of this.defaultContexts) if (context.id === params.executionContextId && context.sessionId === event.sessionId) this.defaultContexts.delete(frameId);
      this.frames = this.frames.filter((frame) => frame.contextId !== params.executionContextId || frame.sessionId !== event.sessionId);
    }
    if (event.method === 'Runtime.executionContextsCleared') {
      for (const [frameId, context] of this.defaultContexts) if (context.sessionId === event.sessionId) this.defaultContexts.delete(frameId);
      this.frames = this.frames.filter((frame) => frame.sessionId !== event.sessionId);
    }
    if (event.method === 'IAB.epochInvalidated') { this.defaultContexts.clear(); this.scripts.clear(); this.resetNetwork(); }
    if (event.method === 'Inspector.targetCrashed') this.resetNetwork();
    if (event.method === 'Page.frameAttached' && typeof params.frameId === 'string') this.frameParents.set(params.frameId, typeof params.parentFrameId === 'string' ? params.parentFrameId : undefined);
    if (event.method === 'Page.frameNavigated') {
      const frame = params.frame as IabJsonObject | undefined;
      if (typeof frame?.id === 'string') {
        const parentId = typeof frame.parentId === 'string' ? frame.parentId : event.sessionId ? this.frameParents.get(frame.id) : undefined;
        const branch = this.frameBranch(frame.id);
        if (!event.sessionId && !parentId) this.invalidateRefs();
        else this.frames = this.frames.filter((cached) => !branch.has(cached.id));
        for (const id of branch) this.defaultContexts.delete(id);
        this.forgetNetworkRequests((request) => !!request.frameId && branch.has(request.frameId) && (request.frameId !== frame.id || request.loaderId !== frame.loaderId));
        for (const id of branch) this.frameParents.delete(id);
        this.frameParents.set(frame.id, parentId);
      }
    }
    if (event.method === 'Page.frameDetached' && typeof params.frameId === 'string') {
      const branch = this.frameBranch(params.frameId);
      this.frames = this.frames.filter((frame) => !branch.has(frame.id));
      for (const id of branch) this.defaultContexts.delete(id);
      this.forgetNetworkRequests((request) => request.sessionId === event.sessionId && !!request.frameId && branch.has(request.frameId));
      if (params.reason !== 'swap') for (const id of branch) this.frameParents.delete(id);
    }
    if (event.method === 'IAB.childFrameDetached' && typeof params.sessionId === 'string') {
      this.frames = this.frames.filter((frame) => frame.sessionId !== params.sessionId);
      for (const [frameId, context] of this.defaultContexts) if (context.sessionId === params.sessionId) this.defaultContexts.delete(frameId);
      this.forgetNetworkRequests((request) => request.sessionId === params.sessionId);
    }
    if (event.method === 'IAB.epochInvalidated') this.invalidateRefs();
    if (event.method === 'Runtime.consoleAPICalled') {
      const location = ((params.stackTrace as IabJsonObject | undefined)?.callFrames as IabJsonObject[] | undefined)?.[0];
      pushBounded(this.messages, { type: typeof params.type === 'string' ? params.type : 'log', text: ((params.args ?? []) as IabJsonValue[]).map(consoleArgument).join(' '), timestamp: new Date().toISOString(), ...(location ? { location: { ...(typeof location.url === 'string' ? { url: location.url } : {}), ...(typeof location.lineNumber === 'number' ? { lineNumber: location.lineNumber } : {}), ...(typeof location.columnNumber === 'number' ? { columnNumber: location.columnNumber } : {}) } } : {}) }, 500);
    }
    if (event.method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as IabJsonObject | undefined;
      const exception = details?.exception as IabJsonObject | undefined;
      if (details) pushBounded(this.errors, { message: String(exception?.description ?? details.text ?? exception?.className ?? 'Uncaught exception'), ...(exception?.className ? { name: String(exception.className) } : {}), ...(exception?.description ? { stack: String(exception.description) } : {}), timestamp: new Date().toISOString() }, 200);
    }
    if (event.method === 'Debugger.scriptParsed' && typeof params.scriptId === 'string') {
      this.scripts.set(`${event.sessionId ?? ''}:${params.scriptId}`, { ...params, ...(event.sessionId ? { sessionId: event.sessionId } : {}) });
      if (this.scripts.size > 1000) this.scripts.delete(this.scripts.keys().next().value!);
    }
    const requestKey = `${event.sessionId ?? ''}\0${params.requestId}`;
    if (event.method === 'Network.requestWillBeSent' && String(params.requestId ?? '')) {
      const previous = this.networkEntries.get(requestKey);
      if (previous && params.redirectResponse) {
        previous.response = params.redirectResponse; previous.finishedAt = Date.now();
      }
      this.activeRequests.set(requestKey, { sessionId: event.sessionId, frameId: typeof params.frameId === 'string' ? params.frameId : undefined, loaderId: typeof params.loaderId === 'string' ? params.loaderId : undefined });      const entry: IabJsonObject = { ...params, id: `r${++this.nextRequest}`, ...(event.sessionId ? { sessionId: event.sessionId } : {}), startedAt: Date.now() };
      this.networkEntries.set(requestKey, entry);
      if (this.networkEntries.size > 1000) this.networkEntries.delete(this.networkEntries.keys().next().value!);
      pushBounded(this.requests, entry);
    }
    const entry = this.networkEntries.get(requestKey);
    if (entry && event.method === 'Network.responseReceived') {
      entry.response = params.response; entry.resourceType = params.type;
      const status = (params.response as IabJsonObject | undefined)?.status;
      if (typeof status === 'number') { entry.status = status; entry.ok = status < 400; }
    }
    if (entry && event.method === 'Network.dataReceived') entry.decodedDataLength = Number(entry.decodedDataLength ?? 0) + Number(params.dataLength ?? 0);
    if (entry && event.method === 'Network.requestWillBeSentExtraInfo') entry.requestExtraInfo = params;
    if (entry && event.method === 'Network.responseReceivedExtraInfo') entry.responseExtraInfo = params;
    if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
      this.activeRequests.delete(requestKey);      if (entry) {
        entry.finishedAt = Date.now();
        entry.encodedDataLength = params.encodedDataLength ?? 0;
        if (event.method === 'Network.loadingFailed') { entry.failure = params; entry.ok = false; if (typeof params.errorText === 'string') entry.failureText = params.errorText; }
        else if (['XHR', 'Fetch', 'Script', 'Document'].includes(String(entry.resourceType))) {
          if (canDispatch) this.collectResponseBody(requestKey, entry, String(params.requestId), event.sessionId, operation!);
          else entry.bodyError = 'Response body was not captured outside a live browser operation';
        }
      }
    }
    if (event.method.startsWith('Network.webSocket')) pushBounded(this.events, { method: event.method, ...params, seq: ++this.eventSequence });
    if (event.method === 'Page.javascriptDialogOpening') {
      const decision = this.dialog ?? { accept: params.type === 'beforeunload' };
      this.dialog = null;
      if (canDispatch) {
        const task = this.send('Page.handleJavaScriptDialog', { accept: decision.accept, ...(decision.promptText === undefined ? {} : { promptText: decision.promptText }) }, operation!).finally(() => this.eventTasks.delete(task));
        this.eventTasks.add(task); this.trackOperation(task);
      }
      pushBounded(this.events, { kind: 'dialog', method: event.method, ...params, accept: decision.accept, seq: ++this.eventSequence });
    }
    if (event.method === 'Page.fileChooserOpened' || event.method.startsWith('Page.download') || event.method === 'Inspector.targetCrashed') pushBounded(this.events, { ...(event.method === 'Inspector.targetCrashed' ? { kind: 'rendererCrash' } : {}), method: event.method, ...params, seq: ++this.eventSequence });
  }
}

function consoleArgument(value: IabJsonValue): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return String(value);
  if (value.unserializableValue !== undefined) return String(value.unserializableValue);
  if (value.type === 'string') return String(value.value ?? '');
  if (value.value !== undefined) {
    try { return typeof value.value === 'object' ? JSON.stringify(value.value) : String(value.value); }
    catch { return String(value.value); }
  }
  return typeof value.description === 'string' ? value.description : typeof value.type === 'string' ? `[${value.type}]` : '';
}

function pushBounded(items: IabJsonObject[], item: IabJsonObject, maximum = 1000): void {
  items.push(item);
  if (items.length > maximum) items.shift();
}

function mapQuadPoint(quad: number[], x: number, y: number): { x: number; y: number } {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad;
  const dx = x0 - x1 + x2 - x3, dy = y0 - y1 + y2 - y3;
  const denominator = (x1 - x2) * (y3 - y2) - (x3 - x2) * (y1 - y2);
  const g = denominator ? (dx * (y3 - y2) - (x3 - x2) * dy) / denominator : 0;
  const h = denominator ? ((x1 - x2) * dy - dx * (y1 - y2)) / denominator : 0;
  const scale = g * x + h * y + 1;
  return { x: ((x1 - x0 + g * x1) * x + (x3 - x0 + h * x3) * y + x0) / scale, y: ((y1 - y0 + g * y1) * x + (y3 - y0 + h * y3) * y + y0) / scale };
}

function clipQuadCenter(quad: number[], width: number, height: number): { x: number; y: number } | undefined {
  let points = [0, 2, 4, 6].map((index) => ({ x: quad[index], y: quad[index + 1] }));
  for (const [axis, bound, above] of [['x', 0, true], ['x', width, false], ['y', 0, true], ['y', height, false]] as const) {
    const clipped: typeof points = [];
    for (let index = 0; index < points.length; index++) {
      const a = points[index], b = points[(index + 1) % points.length];
      const insideA = above ? a[axis] >= bound : a[axis] <= bound;
      const insideB = above ? b[axis] >= bound : b[axis] <= bound;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) { const ratio = (bound - a[axis]) / (b[axis] - a[axis]); clipped.push({ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }); }
    }
    points = clipped;
  }
  if (points.length < 3) return undefined;
  const area = Math.abs(points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2;
  if (area < 1) return undefined;
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}
