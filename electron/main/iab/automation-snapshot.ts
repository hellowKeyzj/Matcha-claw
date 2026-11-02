import type { BrowserSnapshotAction } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabJsonObject } from '../../../src/types/desktop/iab';
import { iabError } from './error';
import type { Frame, IabAutomationPage, Operation } from './automation-page';

type RawRequest = { kind: 'a11yTree' | 'domTree'; text?: string; max?: number; scope?: string; depth?: number; deepText?: boolean; includeHrefInFilter?: boolean };
type Row = { line: string; frame: Frame; backendNodeId?: number; role?: string; name?: string };
export type FusedRow = Row & { placeholder?: string; nth?: number; interactive: boolean };
type AxNode = { ignored?: boolean; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }; value?: { value?: string | number | boolean }; properties?: { name: string; value: { value?: string | number | boolean } }[] };
type CapturedDocument = { frameId: string | number; scrollOffsetX?: number; scrollOffsetY?: number; nodes: { nodeType: number[]; parentIndex: number[]; nodeName: number[]; nodeValue: number[]; backendNodeId: number[]; attributes: number[][]; contentDocumentIndex?: { index: number[]; value: number[] } }; layout: { nodeIndex: number[]; bounds: number[][]; styles: number[][]; text?: number[] } };
type CapturedSnapshot = { strings: string[]; documents: CapturedDocument[] };
type FusedNode = { frame: Frame; backendNodeId?: number; tag: string; role: string; name: string; placeholder?: string; state: Record<string, string | number | boolean>; styles: string[]; bounds?: number[]; parent?: FusedNode; children: FusedNode[]; interactive: boolean; visible: boolean };
const interactiveRoles = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem']);
const contentRoles = new Set(['heading', 'cell', 'gridcell', 'columnheader', 'rowheader', 'listitem', 'article', 'region', 'main', 'navigation']);
const structuralRoles = new Set(['generic', 'group', 'list', 'table', 'row', 'rowgroup', 'grid', 'treegrid', 'menu', 'menubar', 'toolbar', 'tablist', 'tree', 'directory', 'document', 'application', 'presentation', 'none']);
const collapsedRoles = new Set(['generic', 'none', 'presentation', 'document', 'application']);
const intentRules: { roles: string[]; words?: string[] }[] = [
  { roles: ['navigation'] }, { roles: ['contentinfo'] },
  { roles: ['region', 'dialog', 'alertdialog', 'banner', 'complementary', 'alert'], words: ['cookie', 'consent', 'accept all', 'we use cookies', 'agree to', 'cookie 政策', '使用 cookies', '使用cookies', '使用 cookie', '隐私偏好'] },
  { roles: ['complementary', 'region', 'dialog'], words: ['intercom', 'zendesk', 'zopim', 'drift', 'live chat', 'chat with us', 'support chat', 'help chat', 'crisp chat', 'tawk.to', '在线客服', '在线咨询'] },
  { roles: ['navigation', 'list'], words: ['breadcrumb', 'breadcrumbs', '面包屑'] },
  { roles: ['region', 'complementary', 'dialog', 'alertdialog'], words: ['newsletter', 'subscribe', 'sign up for our', 'email updates', 'stay in the loop', 'join our mailing list', '订阅', '邮件订阅', '电子报'] },
  { roles: ['complementary', 'region'], words: ['advertisement', 'sponsored content', 'sponsored', 'advertisement region', 'ad slot', 'promoted content', '广告', '推广', '赞助内容'] },
  { roles: ['complementary', 'navigation', 'region', 'list'], words: ['share this', 'share on', 'share to', 'social share', 'social media', 'follow us on', 'follow us', '分享到', '社交分享', '关注我们'] },
];
const clean = (value: unknown, max: number) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

export async function captureFusedRows(page: IabAutomationPage, frames: Frame[], params: BrowserSnapshotAction, operation: Operation): Promise<FusedRow[]> {
  const ax = new Map<string, AxNode>(), hitNodes: { frame: Frame; node: AxNode }[] = [];
  for (const frame of frames) {
    await page.evaluate(`(async () => {const finite=document.getAnimations().filter(animation=>{const timing=animation.effect?.getComputedTiming();return animation.playState==='running'&&Number.isFinite(timing?.endTime)&&timing.endTime<=250});if(finite.length)await Promise.race([Promise.allSettled(finite.map(animation=>animation.finished)),new Promise(resolve=>setTimeout(resolve,250))]);return true;})()`, operation, frame);
    const result = await page.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', { frameId: frame.id }, operation, frame.sessionId);
    for (const node of result.nodes) {
      hitNodes.push({ frame, node });
      if (!node.ignored && node.backendDOMNodeId && !ax.has(`${frame.id}:${node.backendDOMNodeId}`)) ax.set(`${frame.id}:${node.backendDOMNodeId}`, node);
    }
  }
  const roots: FusedNode[] = [], byBackend = new Map<string, FusedNode>();
  const frameRoots = new Map<string, FusedNode[]>(), parentMaps = new Map<string | undefined, Map<number, number>>();
  const styles = ['display', 'visibility', 'opacity', 'pointer-events', 'position', 'z-index', 'overflow', 'cursor'];
  for (const sessionId of new Set(frames.map((frame) => frame.sessionId))) {
    const capture = await page.send<CapturedSnapshot>('DOMSnapshot.captureSnapshot', { computedStyles: styles, includeDOMRects: true, includePaintOrder: true, includeUserAgentShadowTree: true }, operation, sessionId);
    if (!capture.documents?.length) throw iabError('IAB_FUSED_DOM_EMPTY', 'DOM snapshot returned no documents');
    parentMaps.set(sessionId, await normalizeSnapshotDocuments(page, capture, operation, sessionId));
    for (const document of capture.documents) {
      const frameId = typeof document.frameId === 'number' ? capture.strings[document.frameId] : document.frameId;
      const frame = frames.find((candidate) => candidate.id === frameId && candidate.sessionId === sessionId);
      if (!frame) continue;
      const { nodes, layout } = document;
      const positions = new Map(layout.nodeIndex.map((index, offset) => [index, offset]));
      const mapped = new Map<number, FusedNode>();
      const documentRoots: FusedNode[] = [];
      for (let index = 0; index < nodes.nodeType.length; index++) {
        const type = nodes.nodeType[index];
        if (type !== 1 && type !== 3) continue;
        const backendNodeId = nodes.backendNodeId[index], tag = type === 1 ? (capture.strings[nodes.nodeName[index]] ?? '').toLowerCase() : '';
        const attrs: Record<string, string> = {}, values = nodes.attributes[index] ?? [];
        for (let offset = 0; offset + 1 < values.length; offset += 2) attrs[capture.strings[values[offset]]] = capture.strings[values[offset + 1]];
        const accessibility = ax.get(`${frame.id}:${backendNodeId}`);
        const state: Record<string, string | number | boolean> = {};
        for (const property of accessibility?.properties ?? []) if (property.value.value !== undefined) state[property.name] = property.value.value;
        if (accessibility?.value?.value !== undefined) state.value = String(accessibility.value.value);
        if (attrs.disabled !== undefined || attrs['aria-disabled'] === 'true') state.disabled = true;
        const inputType = attrs.type ?? 'text';
        const implicitRole = tag === 'button' ? 'button' : tag === 'a' && attrs.href !== undefined ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag === 'input' ? inputType === 'checkbox' || inputType === 'radio' ? inputType : ['button', 'submit', 'reset', 'image'].includes(inputType) ? 'button' : inputType === 'range' ? 'slider' : inputType === 'hidden' ? 'generic' : 'textbox' : 'generic';
        const role = accessibility?.role?.value || (type === 3 ? 'StaticText' : attrs.role || implicitRole);
        const position = positions.get(index), computed = position === undefined ? [] : (layout.styles[position] ?? []).map((value) => capture.strings[value]);
        const bounds = position === undefined ? undefined : layout.bounds[position];
        const text = type === 3 ? capture.strings[nodes.nodeValue[index]] : position === undefined ? '' : capture.strings[layout.text?.[position] ?? -1];
        const name = clean(accessibility?.name?.value || (type === 3 ? text : attrs['aria-label'] || attrs.title || attrs.alt), 10000);
        const opacity = Number.parseFloat(computed[2] ?? '1');
        const visible = !['script', 'style', 'noscript', 'template', 'head', 'title'].includes(tag) && (computed.some((value) => value !== undefined) || bounds !== undefined || type === 3) && computed[0] !== 'none' && computed[1] !== 'hidden' && computed[1] !== 'collapse' && !(Number.isFinite(opacity) && opacity <= 0) && !(bounds && (bounds[2] <= 0 || bounds[3] <= 0) && computed[6]?.split(/\s+/u).some((value) => value !== 'visible'));
        const node: FusedNode = { frame, backendNodeId, tag, role, name, placeholder: attrs.placeholder, state, styles: computed, bounds, children: [], interactive: interactiveRoles.has(role), visible };
        const parentIndex = nodes.parentIndex[index];
        const parent = [9, 10, 11].includes(nodes.nodeType[parentIndex]) ? undefined : mapped.get(parentIndex);
        if (parent) { node.parent = parent; parent.children.push(node); } else documentRoots.push(node);
        mapped.set(index, node); byBackend.set(`${frame.id}:${backendNodeId}`, node);
      }
      frameRoots.set(frame.id, documentRoots);
    }
  }
  for (const frame of frames) {
    const children = frameRoots.get(frame.id) ?? [];
    const parentFrame = frames.find((candidate) => candidate.id === frame.parentId);
    if (!parentFrame) { roots.push(...children); continue; }
    const owner = await page.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame.id }, operation, parentFrame.sessionId);
    const parent = byBackend.get(`${parentFrame.id}:${owner.backendNodeId}`);
    if (!parent) throw iabError('IAB_FUSED_FRAME_OWNER_MISSING', 'Frame owner changed during the snapshot');
    for (const child of children) { child.parent = parent; parent.children.push(child); }
  }
  const inferPointer = (node: FusedNode, ancestorInteractive: boolean, inheritedPointer: boolean) => {
    const pointer = node.tag ? node.styles[7] === 'pointer' : inheritedPointer;
    if (node.tag && !ancestorInteractive && !node.interactive && pointer && !inheritedPointer && node.tag !== 'html' && node.tag !== 'body') node.interactive = true;
    for (const child of node.children) inferPointer(child, ancestorInteractive || node.interactive, pointer);
  };
  for (const root of roots) inferPointer(root, false, false);
  for (const [sessionId, parents] of parentMaps) {
    const viewport = await snapshotViewport(page, operation, sessionId);
    for (const { frame, node: accessibility } of hitNodes) {
      if (frame.sessionId !== sessionId || !interactiveRoles.has(accessibility.role?.value?.toLowerCase() ?? '')) continue;
      const backendNodeId = accessibility.backendDOMNodeId;
      if (backendNodeId === undefined) continue;
      const node = byBackend.get(`${frame.id}:${backendNodeId}`);
      if (!node?.bounds || !node.tag) continue;
      const [x, y, width, height] = node.bounds;
      const scaledWidth = width / viewport.scaleX, scaledHeight = height / viewport.scaleY;
      if (!(scaledWidth > 1) || !(scaledHeight > 1)) continue;
      const left = Math.max(x / viewport.scaleX, viewport.x), top = Math.max(y / viewport.scaleY, viewport.y);
      const right = Math.min((x + width) / viewport.scaleX, viewport.x + viewport.width), bottom = Math.min((y + height) / viewport.scaleY, viewport.y + viewport.height);
      if (right <= left || bottom <= top) continue;
      const columns = Math.min(8, Math.max(1, Math.floor((right - left) / 5))), rows = Math.min(8, Math.max(1, Math.floor((bottom - top) / 5)));
      const points = Array.from({ length: columns * rows }, (_, index) => ({ x: left + (Math.floor(index / rows) + 0.5) * (right - left) / columns, y: top + (index % rows + 0.5) * (bottom - top) / rows }));
      if (await sampledHitTarget(page, points, backendNodeId, parents, operation, sessionId) === false) node.visible = false;
    }
  }
  const selector = params.scope?.selector ?? params.selector ?? (params.scope?.landmark ? `role=${params.scope.landmark}` : undefined);
  let selectedRoots = roots;
  if (selector) {
    selectedRoots = [];
    for (const frame of frames) {
      const objectId = await page.evaluate(`globalThis.__matchaIabAutomation.querySelector(globalThis.__matchaIabAutomation.parseSelector(${JSON.stringify(selector)}),document,true)`, operation, frame, false);
      if (!objectId) continue;
      const result = await page.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId }, operation, frame.sessionId);
      const node = byBackend.get(`${frame.id}:${result.node.backendNodeId}`);
      if (node) selectedRoots.push(node);
    }
    if (!selectedRoots.length) throw iabError('IAB_SNAPSHOT_SCOPE_NOT_FOUND', 'Snapshot scope not found');
  }
  const visibleTree = (nodes: FusedNode[]): FusedNode[] => nodes.filter((node) => node.visible).map((node) => { node.children = visibleTree(node.children); return node; });
  let tree = visibleTree(selectedRoots);
  const intentStats = new Map<FusedNode, { interactive: number; hasMain: boolean }>();
  const summarizeIntent = (node: FusedNode): { interactive: number; hasMain: boolean } => {
    const cached = intentStats.get(node);
    if (cached) return cached;
    const stats = { interactive: Number(node.interactive), hasMain: node.role === 'main' };
    for (const child of node.children) {
      const childStats = summarizeIntent(child);
      stats.interactive += childStats.interactive;
      stats.hasMain ||= childStats.hasMain;
    }
    intentStats.set(node, stats);
    return stats;
  };
  const total = tree.reduce((sum, node) => sum + summarizeIntent(node).interactive, 0);
  const pruneIntent = (nodes: FusedNode[]): FusedNode[] => nodes.filter((node) => {
    const matched = intentRules.some((rule) => rule.roles.includes(node.role) && (!rule.words || rule.words.some((word) => node.name.toLowerCase().includes(word))));
    const stats = intentStats.get(node)!;
    return !matched || stats.hasMain || total > 0 && stats.interactive / total > 0.5;
  }).map((node) => { node.children = pruneIntent(node.children); return node; });
  tree = pruneIntent(tree);
  let textBudget = 4000;
  const seenText = new Set<string>();
  const significant = (node: FusedNode) => node.interactive || contentRoles.has(node.role) && !!node.name;
  const pruneText = (nodes: FusedNode[], parentName?: string): FusedNode[] => nodes.filter((node) => {
    if (node.role !== 'StaticText') return true;
    const text = clean(node.name, 10000);
    if (text.length < 2 || text === parentName || seenText.has(text) || textBudget <= 0) return false;
    node.name = text.slice(0, 300); textBudget -= node.name.length; seenText.add(text); return true;
  }).map((node) => { node.children = pruneText(node.children, significant(node) ? node.name : parentName); return node; });
  tree = pruneText(tree);
  const compact = (nodes: FusedNode[], depth: number): FusedNode[] => nodes.flatMap((node) => {
    node.children = params.depth !== undefined && depth >= params.depth ? [] : compact(node.children, depth + 1);
    if (params.compact !== false && !significant(node) && structuralRoles.has(node.role)) return collapsedRoles.has(node.role) ? node.children : node.children.length ? [node] : [];
    return [node];
  });
  tree = compact(tree, 0);
  const rows: FusedRow[] = [], identities = new Map<string, number>();
  const render = (node: FusedNode, depth: number) => {
    const placeholder = node.placeholder?.trim() && node.placeholder.trim() !== node.name.trim() ? node.placeholder.trim() : undefined;
    const key = `${node.frame.id}\0${node.role}\0${node.name}\0${placeholder ?? ''}`, nth = identities.get(key) ?? 0;
    identities.set(key, nth + 1);
    const marks: string[] = [];
    for (const key of ['checked', 'selected', 'expanded', 'pressed', 'disabled']) if (node.state[key] === true || node.state[key] === 'true') marks.push(key); else if (node.state[key] === 'mixed') marks.push(`${key}=mixed`);
    if (node.state.value) marks.push(`value=${JSON.stringify(String(node.state.value))}`);
    rows.push({ frame: node.frame, backendNodeId: significant(node) ? node.backendNodeId : undefined, role: node.role, name: node.name, placeholder, nth, interactive: node.interactive, line: `${'  '.repeat(depth)}- ${node.role === 'StaticText' ? 'text' : node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${placeholder ? ` [placeholder=${JSON.stringify(placeholder)}]` : ''}${marks.length ? ` [${marks.join(' ')}]` : ''}` });
    for (const child of node.children) render(child, depth + 1);
  };
  for (const node of tree) render(node, 0);
  return rows;
}

async function normalizeSnapshotDocuments(page: IabAutomationPage, capture: CapturedSnapshot, operation: Operation, sessionId?: string): Promise<Map<number, number>> {
  const hosts = new Map<number, number>(), locations = new Map<number, { document: number; index: number }>();
  for (const [documentIndex, document] of capture.documents.entries()) {
    document.nodes.backendNodeId.forEach((id, index) => locations.set(id, { document: documentIndex, index }));
    const content = document.nodes.contentDocumentIndex;
    content?.index.forEach((nodeIndex, index) => {
      const child = content.value[index];
      if (child > documentIndex && child < capture.documents.length) hosts.set(child, document.nodes.backendNodeId[nodeIndex]);
    });
  }
  for (let index = 1; index < capture.documents.length; index++) {
    if (hosts.has(index)) continue;
    const document = capture.documents[index], frameId = typeof document.frameId === 'number' ? capture.strings[document.frameId] : document.frameId;
    if (!frameId) continue;
    try {
      const owner = await page.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId }, operation, sessionId);
      if (typeof owner.backendNodeId === 'number' && owner.backendNodeId > 0) hosts.set(index, owner.backendNodeId);
    } catch (error) { checkSnapshotFailure(page, operation, error); }
  }
  const scrolls = new Map<number, { x: number; y: number }>();
  await Promise.all([...hosts].map(async ([index, host]) => {
    let objectId: string | undefined;
    try {
      objectId = (await page.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: host }, operation, sessionId)).object?.objectId;
      if (!objectId) return;
      const result = await page.send<{ result?: { value?: { x: number; y: number } } }>('Runtime.callFunctionOn', { objectId, functionDeclaration: `function(){try{const w=this.contentWindow;if(!w)return null;return {x:w.scrollX||0,y:w.scrollY||0};}catch{return null;}}`, returnByValue: true }, operation, sessionId);
      const scroll = result.result?.value;
      if (scroll && typeof scroll.x === 'number' && typeof scroll.y === 'number') scrolls.set(index, scroll);
    } catch (error) { checkSnapshotFailure(page, operation, error); }
    finally {
      if (objectId) {
        try { await page.send('Runtime.releaseObject', { objectId }, operation, sessionId); }
        catch (error) { checkSnapshotFailure(page, operation, error); }
      }
    }
  }));
  const normalized = new Set<number>();
  const normalize = (index: number) => {
    if (normalized.has(index)) return;
    normalized.add(index);
    const host = hosts.get(index), location = host === undefined ? undefined : locations.get(host);
    if (!location) return;
    normalize(location.document);
    const owner = capture.documents[location.document], position = owner.layout.nodeIndex.indexOf(location.index), bounds = owner.layout.bounds[position];
    const scroll = scrolls.get(index), x = (bounds?.[0] ?? 0) - (scroll?.x ?? 0), y = (bounds?.[1] ?? 0) - (scroll?.y ?? 0);
    if (x || y) capture.documents[index].layout.bounds = capture.documents[index].layout.bounds.map((bounds) => [bounds[0] + x, bounds[1] + y, bounds[2], bounds[3]]);
  };
  const parents = new Map<number, number>();
  for (const [index, document] of capture.documents.entries()) {
    normalize(index);
    const { nodes } = document;
    nodes.backendNodeId.forEach((id, nodeIndex) => {
      const parentIndex = nodes.parentIndex[nodeIndex], type = nodes.nodeType[parentIndex];
      const parent = parentIndex >= 0 && ![9, 10, 11].includes(type) ? nodes.backendNodeId[parentIndex] : hosts.get(index);
      if (parent !== undefined) parents.set(id, parent);
    });
  }
  return parents;
}

async function snapshotViewport(page: IabAutomationPage, operation: Operation, sessionId?: string): Promise<{ x: number; y: number; width: number; height: number; scaleX: number; scaleY: number }> {
  type Viewport = { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
  const finite = (value: unknown, fallback: number): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const scale = (protocol: number | undefined, css: number | undefined): number => {
    const ratio = Number(protocol) / Number(css);
    return Number.isFinite(Number(protocol)) && Number.isFinite(Number(css)) && Number(protocol) > 0 && Number(css) > 0 && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  };
  try {
    const metrics = await page.send<{ cssVisualViewport?: Viewport; visualViewport?: Viewport; cssLayoutViewport?: Viewport; layoutViewport?: Viewport }>('Page.getLayoutMetrics', undefined, operation, sessionId);
    const visual = metrics.cssVisualViewport ?? metrics.visualViewport, layout = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    return { x: finite(visual?.pageX, 0), y: finite(visual?.pageY, 0), width: finite(visual?.clientWidth, finite(layout?.clientWidth, Infinity)), height: finite(visual?.clientHeight, finite(layout?.clientHeight, Infinity)), scaleX: scale(metrics.layoutViewport?.clientWidth, metrics.cssLayoutViewport?.clientWidth), scaleY: scale(metrics.layoutViewport?.clientHeight, metrics.cssLayoutViewport?.clientHeight) };
  } catch (error) {
    checkSnapshotFailure(page, operation, error);
    return { x: 0, y: 0, width: Infinity, height: Infinity, scaleX: 1, scaleY: 1 };
  }
}

async function sampledHitTarget(page: IabAutomationPage, points: { x: number; y: number }[], backendNodeId: number, parents: Map<number, number>, operation: Operation, sessionId?: string): Promise<boolean | undefined> {
  const threshold = Math.ceil(points.length * 0.5);
  let hits = 0;
  for (const [index, point] of points.entries()) {
    let hit: number | undefined;
    try {
      const result = await page.send<{ backendNodeId?: number }>('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false }, operation, sessionId);
      hit = typeof result.backendNodeId === 'number' ? result.backendNodeId : undefined;
    } catch (error) { checkSnapshotFailure(page, operation, error); return; }
    for (let depth = 0; hit !== undefined && depth < 10_000; depth++) {
      if (hit === backendNodeId) { hits++; break; }
      hit = parents.get(hit);
    }
    if (hits >= threshold) return true;
    if (hits + points.length - index - 1 < threshold) return false;
  }
  return hits >= threshold;
}

function checkSnapshotFailure(page: IabAutomationPage, operation: Operation, error: unknown): void {
  operation.signal.throwIfAborted();
  (operation.assertCurrent ?? page.assertCurrent)();
  if (error instanceof Error && 'code' in error && error.code === 'IAB_CDP_OUTCOME_UNKNOWN') throw error;
}

export async function readRawTree(page: IabAutomationPage, request: RawRequest, operation: Operation): Promise<IabJsonObject> {
  const maximum = request.max ?? (request.kind === 'a11yTree' ? 4000 : 2000);
  if (!Number.isInteger(maximum) || maximum < 1 || (request.depth !== undefined && (!Number.isInteger(request.depth) || request.depth < 1))) throw iabError('IAB_TREE_LIMIT_INVALID', 'Tree max and depth must be positive integers');
  const frames = await page.refreshFrames(operation, false);
  const failures: string[] = [];
  const groups = request.kind === 'a11yTree' ? await accessibilityRows(page, frames, request, operation) : await domRows(page, frames, request, operation, failures);
  const count = groups.reduce((sum, group) => sum + group.length, 0);
  const truncated = count > maximum;
  const allRows = groups.flat();
  const head = Math.ceil(maximum / 2), tail = Math.floor(maximum / 2);
  const rows = truncated ? [...allRows.slice(0, head), ...(tail ? allRows.slice(-tail) : [])] : allRows;
  const refs: IabJsonObject = {};
  const lines = rows.map((row) => {
    if (!row.backendNodeId) return row.line;
    const ref = page.registerBackendRef(row.frame, row.backendNodeId);
    refs[ref] = { backendNodeId: row.backendNodeId, frameId: row.frame.id, ...(row.role ? { role: row.role } : {}), ...(row.name ? { name: row.name } : {}) };
    return `${row.line} [ref=${ref}] [frameId=${row.frame.id}]`;
  });
  if (truncated) lines.push(`(truncated: ${count} matched lines, showing first and last ${rows.length}; pass a larger max to widen)`);
  return { tree: lines.join('\n'), count: rows.length, truncated, refs, ...(failures.length ? { degraded: true, degradedReason: failures.join('; ') } : {}) };
}

export async function degradedSnapshot(page: IabAutomationPage, params: BrowserSnapshotAction, reason: string, operation: Operation): Promise<IabJsonObject> {
  const failures: string[] = [];
  for (const kind of ['a11yTree', 'domTree'] as const) {
    try {
      const tree = await readRawTree(page, { kind, max: params.limit ?? 500 }, operation);
      if (!tree.count || !String(tree.tree).trim()) { failures.push(`${kind} returned no nodes`); continue; }
      const recovery = 'Use returned refs, or backendNodeId from [dom=N] with its frameId. Take a fresh snapshot after navigation.';
      const notice = `[degraded snapshot: ${kind}; actionKey=backendNodeId]\nReason: ${reason}\n${recovery}\n\n`;
      const text = notice + String(tree.tree), snapshot = params.maxChars === undefined ? text : text.slice(0, params.maxChars);
      const refs = tree.refs as IabJsonObject;
      const visible = new Set([...snapshot.matchAll(/\[ref=(e\d+)\]/gu)].map((match) => match[1]));
      for (const ref of Object.keys(refs)) if (!visible.has(ref)) delete refs[ref];
      return { snapshot, refs, mode: 'degraded', degraded: true, degradedReason: reason, source: kind, actionKey: 'backendNodeId', count: tree.count, truncated: !!tree.truncated || text.length !== snapshot.length, recovery };
    } catch (error) {
      operation.signal.throwIfAborted();
      (operation.assertCurrent ?? page.assertCurrent)?.();
      failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw iabError('IAB_SNAPSHOT_FAILED', `Snapshot failed: ${reason}. Raw-tree recovery failed (${failures.join('; ')})`);
}

async function accessibilityRows(page: IabAutomationPage, frames: Frame[], request: RawRequest, operation: Operation): Promise<Row[][]> {
  const groups: Row[][] = [], keyword = request.text?.toLowerCase();
  for (const frame of frames) {
    const response = await page.send<any>('Accessibility.getFullAXTree', { frameId: frame.id }, operation, frame.sessionId);
    const nodes: any[] = response.nodes ?? [], byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const children = new Set(nodes.flatMap((node) => node.childIds ?? []));
    const grouped = new Map<string, Row[]>();
    const visit = (node: any, depth: number, parent?: Row) => {
      let row: Row | undefined;
      const role = clean(node.role?.value, 80), name = clean(node.name?.value, 80), value = clean(node.value?.value, 40);
      if (!node.ignored && role !== 'InlineTextBox' && role !== 'none' && (name || value || node.backendDOMNodeId)) {
        const marks: string[] = [];
        for (const property of node.properties ?? []) {
          const value = property.value?.value, key = property.name;
          if (['disabled', 'hidden', 'invisible', 'offscreen', 'focusable', 'focused', 'editable', 'readonly', 'required', 'modal', 'busy', 'selected'].includes(key) && value === true) marks.push(key);
          else if (['checked', 'pressed'].includes(key) && (value === true || value === 'mixed')) marks.push(value === true ? key : `${key}=mixed`);
          else if (key === 'expanded' && typeof value === 'boolean') marks.push(value ? 'expanded' : 'collapsed');
          else if (['hasPopup', 'popup', 'current', 'invalid', 'level', 'placeholder', 'errorMessage'].includes(key) && value !== false && value !== 'false' && value !== 'none' && value !== undefined) marks.push(`${key}=${clean(value, 40)}`);
        }
        const backendNodeId = typeof node.backendDOMNodeId === 'number' && node.backendDOMNodeId > 0 ? node.backendDOMNodeId : undefined;
        row = { frame, backendNodeId, role, name, line: `${'  '.repeat(depth)}- ${role || 'unknown'}${name ? ` ${JSON.stringify(name)}` : ''}${value ? ` value=${JSON.stringify(value)}` : ''}${backendNodeId ? ` [dom=${backendNodeId}]` : ''}${marks.length ? ` [${marks.join(' ')}]` : ''}` };
        if (!keyword || row.line.toLowerCase().includes(keyword)) {
          if (keyword && parent) {
            let group = grouped.get(parent.line);
            if (!group) { group = [parent]; grouped.set(parent.line, group); groups.push(group); }
            group.push(row);
          } else groups.push([row]);
        }
      }
      for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) visit(child, depth + 1, row?.backendNodeId ? row : parent); }
    };
    for (const node of nodes) if (!children.has(node.nodeId)) visit(node, 0);
  }
  return groups;
}

async function liveDomRows(page: IabAutomationPage, frame: Frame, request: RawRequest, operation: Operation): Promise<Row[][]> {
  const objectId = await page.evaluate(`(() => {
    const root=${request.scope ? `document.querySelector(${JSON.stringify(request.scope)})` : 'document.body || document.documentElement'},elements=[];
    const skip=new Set(['script','style','noscript','template','link','meta','path','defs']);
    const walk=(element,depth)=>{if(!element||depth>${request.depth ?? 24}||elements.length>=${(request.max ?? 2000) * 4}||skip.has(element.localName))return;elements.push(element);for(const child of element.children)walk(child,depth+1)};
    walk(root,0);return elements;
  })()`, operation, frame, false);
  if (!objectId) return [];
  const properties = await page.send<any>('Runtime.getProperties', { objectId, ownProperties: true }, operation, frame.sessionId);
  const groups: Row[][] = [], keyword = request.text?.toLowerCase();
  for (const property of properties.result ?? []) {
    if (!/^\d+$/u.test(property.name) || !property.value?.objectId) continue;
    const element = { frame, objectId: property.value.objectId };
    const data = await page.callElement(element, `
      const tag=this.localName,attrs=Object.fromEntries([...this.attributes].map(attr=>[attr.name,attr.value])),style=getComputedStyle(this),rect=this.getBoundingClientRect();
      const type=(attrs.type||'').toLowerCase(),nonText=new Set(['button','submit','reset','checkbox','radio','hidden','file','range','color','image']);
      let own='';for(const child of this.childNodes)if(child.nodeType===3)own+=child.textContent;
      const clean=(value,max)=>String(value||'').replace(/\\s+/g,' ').trim().slice(0,max);
      own=clean(own,60);
      const clickable=(tag==='a'&&this.hasAttribute('href'))||['button','select','summary','label'].includes(tag)||(tag==='input'&&type!=='hidden')||this.hasAttribute('onclick')||style.cursor==='pointer';
      const editable=tag==='textarea'||this.isContentEditable||(tag==='input'&&!nonText.has(type));
      const hidden=rect.width<=0||rect.height<=0||style.visibility==='hidden'||style.display==='none',off=!hidden&&(rect.bottom<0||rect.top>innerHeight||rect.right<0||rect.left>innerWidth);
      let depth=0,parent=this;while(parent.parentElement&&parent.parentElement!==document.body){depth++;parent=parent.parentElement;}
      let marks=hidden?' (hidden)':off?' (offscreen)':'';
      if(this.disabled||attrs['aria-disabled']==='true')marks+=' [disabled]';if(editable)marks+=' [edit]';if(clickable)marks+=' [click]';
      if(tag==='input'&&type)marks+=' [type='+type+']';if(tag==='a'&&attrs.href)marks+=' href='+JSON.stringify(attrs.href.slice(0,80));if(attrs.target==='_blank')marks+=' [newtab]';
      const line='  '.repeat(depth)+'<'+tag+(attrs.id?'#'+attrs.id.slice(0,40):'')+[...this.classList].slice(0,2).map(name=>'.'+name.slice(0,30)).join('')+'>'+(own?' '+JSON.stringify(own):'');
      const values=[own,attrs['aria-label'],attrs.title,attrs.placeholder,attrs.value,attrs.alt,args[0]?clean(this.textContent,500):'',args[1]?attrs.href:''];
      return {line,marks,name:own,role:attrs.role||tag,values};
    `, [!!request.deepText, !!request.includeHrefInFilter], operation);
    if (keyword && !data.values.some((value: unknown) => typeof value === 'string' && value.toLowerCase().includes(keyword))) continue;
    const description = await page.send<any>('DOM.describeNode', { objectId: element.objectId }, operation, frame.sessionId);
    const backendNodeId = description.node?.backendNodeId;
    groups.push([{ frame, backendNodeId, name: data.name, role: data.role, line: `${data.line}${backendNodeId ? ` [dom=${backendNodeId}]` : ''}${data.marks}` }]);
  }
  return groups;
}

async function domRows(page: IabAutomationPage, frames: Frame[], request: RawRequest, operation: Operation, failures: string[]): Promise<Row[][]> {
  const groups: Row[][] = [], keyword = request.text?.toLowerCase();
  const skip = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'base', 'head', 'title', 'path', 'defs']);
  const nonText = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'hidden', 'file', 'range', 'color', 'image']);
  let scope = request.scope;
  let scopedFrames = frames;
  while (scope?.includes('>>>')) {
    const split = scope.indexOf('>>>'), host = scope.slice(0, split).trim();
    let child: Frame | undefined;
    for (const frame of scopedFrames) {
      const objectId = await page.evaluate(`document.querySelector(${JSON.stringify(host)})`, operation, frame, false);
      if (!objectId) continue;
      const description = await page.send<any>('DOM.describeNode', { objectId }, operation, frame.sessionId);
      await page.send('Runtime.releaseObject', { objectId }, operation, frame.sessionId);
      child = frames.find((candidate) => candidate.id === description.node?.frameId);
      if (child) break;
    }
    if (!child) return [];
    scopedFrames = [child]; scope = scope.slice(split + 3).trim();
  }
  for (const sessionId of new Set(scopedFrames.map((frame) => frame.sessionId))) {
    let capture: any;
    try { capture = await page.send<any>('DOMSnapshot.captureSnapshot', { computedStyles: ['display', 'visibility', 'cursor'], includeDOMRects: true, includePaintOrder: true, includeUserAgentShadowTree: true }, operation, sessionId); }
    catch (error) { operation.signal.throwIfAborted(); (operation.assertCurrent ?? page.assertCurrent)?.(); failures.push(error instanceof Error ? error.message : String(error)); capture = undefined; }
    if (!capture?.documents?.length || !capture.strings) {
      for (const frame of scopedFrames.filter((candidate) => candidate.sessionId === sessionId)) groups.push(...await liveDomRows(page, frame, { ...request, scope }, operation));
      continue;
    }
    const strings: string[] = capture.strings ?? [];
    for (const document of capture.documents ?? []) {
      const frame = scopedFrames.find((frame) => frame.id === (typeof document.frameId === 'number' ? strings[document.frameId] : document.frameId) && frame.sessionId === sessionId);
      if (!frame) continue;
      const nodes = document.nodes, layout = document.layout;
      if (!nodes?.nodeType) continue;
      const children = new Map<number, number[]>(), attributes = new Map<number, Record<string, string>>();
      for (let index = 0; index < nodes.nodeType.length; index++) {
        const parent = nodes.parentIndex[index], siblings = children.get(parent) ?? [];
        siblings.push(index); children.set(parent, siblings);
        const values: number[] = nodes.attributes[index] ?? [], attrs: Record<string, string> = {};
        for (let offset = 0; offset + 1 < values.length; offset += 2) attrs[strings[values[offset]]] = strings[values[offset + 1]];
        attributes.set(index, attrs);
      }
      const layoutIndex = new Map<number, number>((layout?.nodeIndex ?? []).map((node: number, index: number) => [node, index]));
      const text = (index: number, deep: boolean): string => {
        let value = '';
        for (const child of children.get(index) ?? []) {
          if (nodes.nodeType[child] === 3) value += strings[nodes.nodeValue[child]] ?? '';
          else if (deep && value.length < 500) value += text(child, true);
        }
        return clean(value, deep ? 500 : 60);
      };
      let root = nodes.nodeName.findIndex((name: number) => strings[name]?.toLowerCase() === 'body');
      if (scope) {
        const selector = JSON.stringify(scope);
        const objectId = await page.evaluate(`document.querySelector(${selector})`, operation, frame, false);
        if (!objectId) continue;
        const description = await page.send<any>('DOM.describeNode', { objectId }, operation, sessionId);
        root = nodes.backendNodeId.indexOf(description.node?.backendNodeId);
        await page.send('Runtime.releaseObject', { objectId }, operation, sessionId);
      }
      if (root < 0) continue;
      const viewport = await page.evaluate('({width:innerWidth,height:innerHeight})', operation, frame);
      const grouped = new Map<number, Row[]>();
      const visit = (index: number, depth: number, parent?: Row) => {
        const tag = strings[nodes.nodeName[index]]?.toLowerCase();
        if (nodes.nodeType[index] !== 1 || !tag || skip.has(tag) || (!keyword && depth > (request.depth ?? 24))) return;
        const attrs = attributes.get(index)!, type = (attrs.type ?? '').toLowerCase(), position = layoutIndex.get(index);
        const bounds = position === undefined ? undefined : layout.bounds?.[position], style = position === undefined ? [] : (layout.styles?.[position] ?? []).map((value: number) => strings[value]);
        const hidden = !bounds || bounds[2] <= 0 || bounds[3] <= 0 || style[0] === 'none' || style[1] === 'hidden';
        const offscreen = !hidden && (bounds[0] + bounds[2] < (document.scrollOffsetX ?? 0) || bounds[1] + bounds[3] < (document.scrollOffsetY ?? 0) || bounds[0] > (document.scrollOffsetX ?? 0) + viewport.width || bounds[1] > (document.scrollOffsetY ?? 0) + viewport.height);
        const clickable = (tag === 'a' && attrs.href !== undefined) || ['button', 'select', 'summary', 'label'].includes(tag) || (tag === 'input' && type !== 'hidden') || style[2] === 'pointer' || attrs.role === 'button';
        const editable = tag === 'textarea' || (tag === 'input' && !nonText.has(type)) || (attrs.contenteditable !== undefined && attrs.contenteditable !== 'false');
        const own = text(index, false), backendNodeId = nodes.backendNodeId[index];
        const marks = ` [dom=${backendNodeId}]${hidden ? ' (hidden)' : offscreen ? ' (offscreen)' : ''}${attrs.disabled !== undefined || attrs['aria-disabled'] === 'true' ? ' [disabled]' : ''}${editable ? ' [edit]' : ''}${clickable ? ' [click]' : ''}${tag === 'input' && type ? ` [type=${type}]` : ''}${tag === 'a' && attrs.href ? ` href=${JSON.stringify(attrs.href.slice(0, 80))}` : ''}${attrs.target === '_blank' ? ' [newtab]' : ''}`;
        const row: Row = { frame, backendNodeId, role: attrs.role || tag, name: own, line: `${'  '.repeat(depth)}<${tag}${attrs.id ? `#${attrs.id.slice(0, 40)}` : ''}${(attrs.class ?? '').split(/\s+/u).filter(Boolean).slice(0, 2).map((name) => `.${name.slice(0, 30)}`).join('')}>${own ? ` ${JSON.stringify(own)}` : ''}${marks}` };
        const matches = !keyword || [own, attrs['aria-label'], attrs.title, attrs.placeholder, attrs.value, attrs.alt, request.deepText ? text(index, true) : '', request.includeHrefInFilter ? attrs.href : ''].some((value) => value?.toLowerCase().includes(keyword));
        if (matches) {
          if (keyword && parent && parent.backendNodeId !== backendNodeId) {
            let group = grouped.get(parent.backendNodeId!);
            if (!group) { group = [parent]; grouped.set(parent.backendNodeId!, group); groups.push(group); }
            group.push(row);
          } else groups.push([row]);
        }
        for (const child of children.get(index) ?? []) visit(child, depth + 1, clickable || editable ? row : parent);
      };
      visit(root, 0);
    }
  }
  return groups;
}
