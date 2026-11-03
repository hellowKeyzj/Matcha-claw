import { checkSnapshotFailure } from './native-snapshot.js'
import type { NativeFrame, NativeRow, NativeScope, NativeSend, NativeSnapshotOptions, NativeTransport } from './native-snapshot.js'
import { ScopeEmptyError, ScopeFrameMultiMatchError } from './snapshot-errors.js'

export type AxNode = {
  nodeId: string
  childIds?: string[]
  ignored?: boolean
  backendDOMNodeId?: number
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string | number | boolean }
  properties?: { name: string; value: { value?: string | number | boolean } }[]
}
type CapturedDocument = {
  frameId: string | number
  nodes: { nodeType: number[]; parentIndex: number[]; nodeName: number[]; nodeValue: number[]; backendNodeId: number[]; attributes: number[][]; contentDocumentIndex?: { index: number[]; value: number[] } }
  layout: { nodeIndex: number[]; bounds: number[][]; styles: number[][]; text?: number[] }
}
type CapturedSnapshot = { strings: string[]; documents: CapturedDocument[] }
type FusedNode = {
  frame: NativeFrame
  backendNodeId: number
  tag: string
  role: string
  name: string
  placeholder?: string
  state: Record<string, string | number | boolean>
  styles: string[]
  bounds?: number[]
  parent?: FusedNode
  children: FusedNode[]
  interactive: boolean
  visible: boolean
}
export const interactiveRoles = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem'])
const contentRoles = new Set(['heading', 'cell', 'gridcell', 'columnheader', 'rowheader', 'listitem', 'article', 'region', 'main', 'navigation'])
const structuralRoles = new Set(['generic', 'group', 'list', 'table', 'row', 'rowgroup', 'grid', 'treegrid', 'menu', 'menubar', 'toolbar', 'tablist', 'tree', 'directory', 'document', 'application', 'presentation', 'none'])
const collapsedRoles = new Set(['generic', 'none', 'presentation', 'document', 'application'])
const intentRules: { roles: string[]; words?: string[] }[] = [
  { roles: ['navigation'] }, { roles: ['contentinfo'] },
  { roles: ['region', 'dialog', 'alertdialog', 'banner', 'complementary', 'alert'], words: ['cookie', 'consent', 'accept all', 'we use cookies', 'agree to', 'cookie 政策', '使用 cookies', '使用cookies', '使用 cookie', '隐私偏好'] },
  { roles: ['complementary', 'region', 'dialog'], words: ['intercom', 'zendesk', 'zopim', 'drift', 'live chat', 'chat with us', 'support chat', 'help chat', 'crisp chat', 'tawk.to', '在线客服', '在线咨询'] },
  { roles: ['navigation', 'list'], words: ['breadcrumb', 'breadcrumbs', '面包屑'] },
  { roles: ['region', 'complementary', 'dialog', 'alertdialog'], words: ['newsletter', 'subscribe', 'sign up for our', 'email updates', 'stay in the loop', 'join our mailing list', '订阅', '邮件订阅', '电子报'] },
  { roles: ['complementary', 'region'], words: ['advertisement', 'sponsored content', 'sponsored', 'advertisement region', 'ad slot', 'promoted content', '广告', '推广', '赞助内容'] },
  { roles: ['complementary', 'navigation', 'region', 'list'], words: ['share this', 'share on', 'share to', 'social share', 'social media', 'follow us on', 'follow us', '分享到', '社交分享', '关注我们'] },
]
const landmarks: Record<string, string> = { main: 'main,[role="main"]', nav: 'nav,[role="navigation"]', form: 'form,[role="form"]', search: '[role="search"]', aside: 'aside,[role="complementary"]', header: 'header,[role="banner"]', footer: 'footer,[role="contentinfo"]' }
const clean = (value: unknown, max = 10000) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)

async function queryNodes(transport: NativeTransport, frame: NativeFrame, selector: string): Promise<{ backendNodeId: number; frameId?: string }[]> {
  return transport.withFrameSession(frame.id, async ({ send, contextId }) => {
    const response = await send('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`, ...(contextId === undefined ? {} : { contextId }), returnByValue: false })
    if (response.exceptionDetails) throw new Error(`Invalid snapshot selector ${JSON.stringify(selector)}: ${response.exceptionDetails.text}`)
    const objectId = response.result?.objectId
    if (!objectId) return []
    const objects = new Set<string>([objectId])
    try {
      const properties = await send('Runtime.getProperties', { objectId, ownProperties: true })
      const nodes: { backendNodeId: number; frameId?: string }[] = []
      for (const property of properties.result ?? []) {
        if (!/^\d+$/u.test(property.name) || !property.value?.objectId) continue
        const elementId = property.value.objectId
        objects.add(elementId)
        const { node } = await send('DOM.describeNode', { objectId: elementId, depth: 0 })
        if (typeof node?.backendNodeId === 'number') nodes.push({ backendNodeId: node.backendNodeId, frameId: node.contentDocument?.frameId ?? node.frameId })
      }
      return nodes
    } finally {
      for (const id of objects) {
        try { await send('Runtime.releaseObject', { objectId: id }) }
        catch (error) { checkSnapshotFailure(transport, error) }
      }
    }
  })
}

export async function selectSnapshotScope(transport: NativeTransport, frames: NativeFrame[], options: NativeSnapshotOptions): Promise<NativeScope> {
  const root = frames.find((frame) => !frame.parentId) ?? frames[0]
  if (!root) throw new Error('No native browser frame is available')
  const frameSelector = options.scope?.frame?.trim() || options.frame?.trim()
  let selected = frames
  if (frameSelector) {
    const matches = await queryNodes(transport, root, frameSelector)
    if (!matches.length) throw new ScopeEmptyError('frame_not_found', `scope.frame ${JSON.stringify(frameSelector)} matched 0 iframes.`)
    if (matches.length > 1) throw new ScopeFrameMultiMatchError(frameSelector, matches.length)
    let frame = frames.find((candidate) => candidate.id === matches[0].frameId && candidate.id !== root.id)
    if (!frame) {
      for (const candidate of frames.filter((item) => item.parentId === root.id)) {
        const owner = await transport.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId: candidate.id }, root.sessionId)
        if (owner.backendNodeId === matches[0].backendNodeId) { frame = candidate; break }
      }
    }
    if (!frame) throw new ScopeEmptyError('frame_not_found', `scope.frame ${JSON.stringify(frameSelector)} is not an attached iframe.`)
    selected = [frame]
    const included = new Set([frame.id])
    for (let changed = true; changed;) {
      changed = false
      for (const child of frames) if (child.parentId && included.has(child.parentId) && !included.has(child.id)) { included.add(child.id); selected.push(child); changed = true }
    }
  }
  const landmark = options.scope?.landmark?.trim()
  const selector = landmark ? landmarks[landmark] ?? landmark : options.scope?.selector?.trim() || options.selector?.trim()
  if (!selector) return { frames: selected }
  const roots = new Map<string, Set<number>>()
  // CSS is evaluated in the selected document; embedded document trees remain native children.
  for (const frame of frameSelector ? selected.slice(0, 1) : selected) {
    const matches = await queryNodes(transport, frame, selector)
    if (matches.length) roots.set(frame.id, new Set(matches.map((node) => node.backendNodeId)))
  }
  if (!roots.size) throw new ScopeEmptyError(landmark ? 'landmark_not_found' : 'selector_no_match', `scope ${landmark ? `landmark=${landmark}` : `selector=${JSON.stringify(selector)}`} matched 0 elements.`)
  return { frames: selected, roots }
}

export async function readAccessibility(transport: NativeTransport, frames: NativeFrame[]): Promise<{ frame: NativeFrame; nodes: AxNode[] }[]> {
  const settled = await Promise.allSettled(frames.map(async (frame) => {
    const result = await transport.send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree', { frameId: frame.id }, frame.sessionId)
    return { frame, nodes: result.nodes ?? [] }
  }))
  const groups: { frame: NativeFrame; nodes: AxNode[] }[] = []
  for (const result of settled) {
    if (result.status === 'fulfilled') groups.push(result.value)
    else checkSnapshotFailure(transport, result.reason)
  }
  if (groups.some((group) => group.nodes.length)) return groups
  const root = frames.find((frame) => !frame.parentId) ?? frames[0]
  if (!root) return []
  const result = await transport.send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree', undefined, root.sessionId)
  return [{ frame: root, nodes: result.nodes ?? [] }]
}

async function settleAnimations(transport: NativeTransport, frame: NativeFrame): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lateFailure: unknown
  const pending = transport.evaluate(`(() => {
    try {
      const finite=document.getAnimations().filter(a=>{try{const timing=a.effect&&a.effect.getComputedTiming();return a.playState==='running'&&Number.isFinite(timing?.endTime)&&timing.endTime<=250}catch{return false}});
      if(!finite.length)return 'none';
      return Promise.race([Promise.all(finite.map(a=>a.finished.catch(()=>null))).then(()=>'settled'),new Promise(resolve=>setTimeout(()=>resolve('budget'),250))]);
    }catch{return 'unsupported'}
  })()`, frame).catch((error) => { lateFailure = error })
  try {
    await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, 550) })])
    if (lateFailure !== undefined) checkSnapshotFailure(transport, lateFailure)
    transport.assertCurrent()
  } finally { if (timer) clearTimeout(timer) }
}

async function normalizeDocuments(send: NativeSend, transport: NativeTransport, capture: CapturedSnapshot): Promise<Map<number, number>> {
  const hosts = new Map<number, number>(), locations = new Map<number, { document: number; index: number }>()
  for (const [documentIndex, document] of capture.documents.entries()) {
    document.nodes.backendNodeId.forEach((id, index) => locations.set(id, { document: documentIndex, index }))
    const content = document.nodes.contentDocumentIndex
    content?.index.forEach((nodeIndex, index) => { const child = content.value[index]; if (child > documentIndex && child < capture.documents.length) hosts.set(child, document.nodes.backendNodeId[nodeIndex]) })
  }
  for (let index = 1; index < capture.documents.length; index++) {
    if (hosts.has(index)) continue
    const document = capture.documents[index], frameId = typeof document.frameId === 'number' ? capture.strings[document.frameId] : document.frameId
    if (!frameId) continue
    try { const owner = await send('DOM.getFrameOwner', { frameId }); if (owner.backendNodeId > 0) hosts.set(index, owner.backendNodeId) }
    catch (error) { checkSnapshotFailure(transport, error) }
  }
  const scrolls = new Map<number, { x: number; y: number }>()
  await Promise.all([...hosts].map(async ([index, backendNodeId]) => {
    let objectId: string | undefined
    try {
      objectId = (await send('DOM.resolveNode', { backendNodeId })).object?.objectId
      if (!objectId) return
      const result = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){try{const w=this.contentWindow;return w?{x:w.scrollX||0,y:w.scrollY||0}:null}catch{return null}}', returnByValue: true })
      const scroll = result.result?.value
      if (scroll && typeof scroll.x === 'number' && typeof scroll.y === 'number') scrolls.set(index, scroll)
    } catch (error) { checkSnapshotFailure(transport, error) }
    finally {
      if (objectId) try { await send('Runtime.releaseObject', { objectId }) } catch (error) { checkSnapshotFailure(transport, error) }
    }
  }))
  const normalized = new Set<number>()
  const normalize = (index: number) => {
    if (normalized.has(index)) return
    normalized.add(index)
    const host = hosts.get(index), location = host === undefined ? undefined : locations.get(host)
    if (!location) return
    normalize(location.document)
    const owner = capture.documents[location.document], position = owner.layout.nodeIndex.indexOf(location.index), bounds = owner.layout.bounds[position]
    const scroll = scrolls.get(index), x = (bounds?.[0] ?? 0) - (scroll?.x ?? 0), y = (bounds?.[1] ?? 0) - (scroll?.y ?? 0)
    if (x || y) capture.documents[index].layout.bounds = capture.documents[index].layout.bounds.map((box) => [box[0] + x, box[1] + y, box[2], box[3]])
  }
  const parents = new Map<number, number>()
  for (const [index, document] of capture.documents.entries()) {
    normalize(index)
    document.nodes.backendNodeId.forEach((id, nodeIndex) => {
      const parentIndex = document.nodes.parentIndex[nodeIndex], type = document.nodes.nodeType[parentIndex]
      const parent = parentIndex >= 0 && ![9, 10, 11].includes(type) ? document.nodes.backendNodeId[parentIndex] : hosts.get(index)
      if (parent !== undefined) parents.set(id, parent)
    })
  }
  return parents
}

async function viewport(transport: NativeTransport, sessionId?: string): Promise<{ x: number; y: number; width: number; height: number; scaleX: number; scaleY: number }> {
  const finite = (value: unknown, fallback: number): number => Number.isFinite(Number(value)) ? Number(value) : fallback
  const ratio = (a?: number, b?: number) => a && b && a > 0 && b > 0 && Number.isFinite(a / b) ? a / b : 1
  try {
    const metrics = await transport.send<any>('Page.getLayoutMetrics', undefined, sessionId)
    const visual = metrics.cssVisualViewport ?? metrics.visualViewport, layout = metrics.cssLayoutViewport ?? metrics.layoutViewport
    return { x: finite(visual?.pageX, 0), y: finite(visual?.pageY, 0), width: finite(visual?.clientWidth, finite(layout?.clientWidth, Infinity)), height: finite(visual?.clientHeight, finite(layout?.clientHeight, Infinity)), scaleX: ratio(metrics.layoutViewport?.clientWidth, metrics.cssLayoutViewport?.clientWidth), scaleY: ratio(metrics.layoutViewport?.clientHeight, metrics.cssLayoutViewport?.clientHeight) }
  } catch (error) { checkSnapshotFailure(transport, error); return { x: 0, y: 0, width: Infinity, height: Infinity, scaleX: 1, scaleY: 1 } }
}

async function sampledHit(transport: NativeTransport, points: { x: number; y: number }[], backendNodeId: number, parents: Map<number, number>, sessionId?: string): Promise<boolean | undefined> {
  const threshold = Math.ceil(points.length * 0.5)
  let hits = 0
  for (const [index, point] of points.entries()) {
    let hit: number | undefined
    try { hit = (await transport.send<{ backendNodeId?: number }>('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false }, sessionId)).backendNodeId }
    catch (error) { checkSnapshotFailure(transport, error); return }
    for (let depth = 0; hit !== undefined && depth < 10000; depth++) { if (hit === backendNodeId) { hits++; break } hit = parents.get(hit) }
    if (hits >= threshold) return true
    if (hits + points.length - index - 1 < threshold) return false
  }
  return hits >= threshold
}

export async function captureFusedRows(transport: NativeTransport, frames: NativeFrame[], scope: NativeScope, options: NativeSnapshotOptions): Promise<NativeRow[]> {
  const root = frames.find((frame) => !frame.parentId) ?? frames[0]
  if (!root) throw new Error('No native browser frame is available')
  await settleAnimations(transport, root)
  const axGroups = await readAccessibility(transport, frames)
  const ax = new Map<string, AxNode>()
  for (const { frame, nodes } of axGroups) for (const node of nodes) if (!node.ignored && node.backendDOMNodeId && !ax.has(`${frame.id}:${node.backendDOMNodeId}`)) ax.set(`${frame.id}:${node.backendDOMNodeId}`, node)
  const byBackend = new Map<string, FusedNode>(), frameRoots = new Map<string, FusedNode[]>()
  const parentMaps = new Map<string | undefined, Map<number, number>>()
  const styles = ['display', 'visibility', 'opacity', 'pointer-events', 'position', 'z-index', 'overflow', 'cursor']
  for (const sessionId of new Set(frames.map((frame) => frame.sessionId))) {
    const representative = frames.find((frame) => frame.sessionId === sessionId)!
    const capture = await transport.send<CapturedSnapshot>('DOMSnapshot.captureSnapshot', { computedStyles: styles, includeDOMRects: true, includePaintOrder: true, includeUserAgentShadowTree: true }, sessionId)
    if (!capture.documents?.length) throw new Error('DOM snapshot returned no documents')
    parentMaps.set(sessionId, await transport.withFrameSession(representative.id, ({ send }) => normalizeDocuments(send, transport, capture)))
    for (const document of capture.documents) {
      const frameId = typeof document.frameId === 'number' ? capture.strings[document.frameId] : document.frameId
      const frame = frames.find((candidate) => candidate.id === frameId && candidate.sessionId === sessionId)
      if (!frame) continue
      const { nodes, layout } = document, positions = new Map(layout.nodeIndex.map((index, offset) => [index, offset]))
      const mapped = new Map<number, FusedNode>(), roots: FusedNode[] = []
      for (let index = 0; index < nodes.nodeType.length; index++) {
        const type = nodes.nodeType[index]
        if (type !== 1 && type !== 3) continue
        const backendNodeId = nodes.backendNodeId[index], tag = type === 1 ? (capture.strings[nodes.nodeName[index]] ?? '').toLowerCase() : ''
        const attrs: Record<string, string> = {}, values = nodes.attributes[index] ?? []
        for (let offset = 0; offset + 1 < values.length; offset += 2) attrs[capture.strings[values[offset]]] = capture.strings[values[offset + 1]]
        const accessibility = ax.get(`${frame.id}:${backendNodeId}`), state: Record<string, string | number | boolean> = {}
        for (const property of accessibility?.properties ?? []) if (property.value.value !== undefined) state[property.name] = property.value.value
        if (accessibility?.value?.value !== undefined) state.value = String(accessibility.value.value)
        const inputType = (attrs.type ?? 'text').toLowerCase()
        const implicit = tag === 'button' ? 'button' : tag === 'a' && attrs.href !== undefined ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag === 'input' ? ['checkbox', 'radio'].includes(inputType) ? inputType : ['button', 'submit', 'reset', 'image'].includes(inputType) ? 'button' : inputType === 'range' ? 'slider' : inputType === 'hidden' ? 'generic' : 'textbox' : 'generic'
        const role = accessibility?.role?.value || (type === 3 ? 'StaticText' : implicit)
        const position = positions.get(index), computed = position === undefined ? [] : (layout.styles[position] ?? []).map((value) => capture.strings[value])
        const bounds = position === undefined ? undefined : layout.bounds[position]
        const text = type === 3 ? capture.strings[nodes.nodeValue[index]] : position === undefined ? '' : capture.strings[layout.text?.[position] ?? -1]
        const name = clean(accessibility?.name?.value || (type === 3 ? text : attrs['aria-label'] || attrs.title || attrs.alt))
        const opacity = Number.parseFloat(computed[2] ?? '1')
        const visible = !['script', 'style', 'noscript', 'template', 'head', 'title'].includes(tag) && (computed.some((value) => value !== undefined) || bounds !== undefined || type === 3) && computed[0] !== 'none' && computed[1] !== 'hidden' && computed[1] !== 'collapse' && !(Number.isFinite(opacity) && opacity <= 0) && !(bounds && (bounds[2] <= 0 || bounds[3] <= 0) && computed[6]?.split(/\s+/u).some((value) => value !== 'visible'))
        const node: FusedNode = { frame, backendNodeId, tag, role, name, placeholder: attrs.placeholder, state, styles: computed, bounds, children: [], interactive: interactiveRoles.has(role), visible }
        const parentIndex = nodes.parentIndex[index], parent = [9, 10, 11].includes(nodes.nodeType[parentIndex]) ? undefined : mapped.get(parentIndex)
        if (parent) { node.parent = parent; parent.children.push(node) } else roots.push(node)
        mapped.set(index, node); byBackend.set(`${frame.id}:${backendNodeId}`, node)
      }
      frameRoots.set(frame.id, roots)
    }
  }
  if (!byBackend.size) throw new Error('DOM snapshot returned no native nodes')
  const roots: FusedNode[] = []
  for (const frame of frames) {
    const children = frameRoots.get(frame.id) ?? [], parentFrame = frames.find((candidate) => candidate.id === frame.parentId)
    if (!parentFrame) { roots.push(...children); continue }
    const owner = await transport.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame.id }, parentFrame.sessionId)
    const parent = byBackend.get(`${parentFrame.id}:${owner.backendNodeId}`)
    if (!parent) throw new Error('Frame owner changed during the snapshot')
    for (const child of children) { child.parent = parent; parent.children.push(child) }
  }
  const inferPointer = (node: FusedNode, ancestorInteractive: boolean, inheritedPointer: boolean) => {
    const pointer = node.tag ? node.styles[7] === 'pointer' : inheritedPointer
    if (node.tag && !ancestorInteractive && !node.interactive && pointer && !inheritedPointer && node.tag !== 'html' && node.tag !== 'body') node.interactive = true
    for (const child of node.children) inferPointer(child, ancestorInteractive || node.interactive, pointer)
  }
  for (const node of roots) inferPointer(node, false, false)
  for (const [sessionId, parents] of parentMaps) {
    const view = await viewport(transport, sessionId)
    for (const { frame, nodes } of axGroups) {
      if (frame.sessionId !== sessionId) continue
      for (const accessibility of nodes) {
        if (!interactiveRoles.has(accessibility.role?.value?.toLowerCase() ?? '') || !accessibility.backendDOMNodeId) continue
        const node = byBackend.get(`${frame.id}:${accessibility.backendDOMNodeId}`)
        if (!node?.bounds || !node.tag) continue
        const [x, y, width, height] = node.bounds
        if (!(width / view.scaleX > 1) || !(height / view.scaleY > 1)) continue
        const left = Math.max(x / view.scaleX, view.x), top = Math.max(y / view.scaleY, view.y)
        const right = Math.min((x + width) / view.scaleX, view.x + view.width), bottom = Math.min((y + height) / view.scaleY, view.y + view.height)
        if (right <= left || bottom <= top) continue
        const columns = Math.min(8, Math.max(1, Math.floor((right - left) / 5))), count = Math.min(8, Math.max(1, Math.floor((bottom - top) / 5)))
        const points = Array.from({ length: columns * count }, (_, index) => ({ x: left + (Math.floor(index / count) + 0.5) * (right - left) / columns, y: top + (index % count + 0.5) * (bottom - top) / count }))
        if (await sampledHit(transport, points, accessibility.backendDOMNodeId, parents, sessionId) === false) node.visible = false
      }
    }
  }
  let selected = scope.roots
    ? [...scope.roots].flatMap(([frameId, ids]) => [...ids].map((id) => byBackend.get(`${frameId}:${id}`)).filter((node): node is FusedNode => !!node))
    : scope.frames.filter((frame) => !scope.frames.some((parent) => parent.id === frame.parentId)).flatMap((frame) => frameRoots.get(frame.id) ?? [])
  const selectedSet = new Set(selected)
  selected = selected.filter((node) => { for (let parent = node.parent; parent; parent = parent.parent) if (selectedSet.has(parent)) return false; return true })
  return pruneAndRender(selected, options)
}

function pruneAndRender(roots: FusedNode[], options: NativeSnapshotOptions): NativeRow[] {
  const visible = (nodes: FusedNode[]): FusedNode[] => nodes.filter((node) => node.visible).map((node) => { node.children = visible(node.children); return node })
  let tree = visible(roots)
  const intent = new Map<FusedNode, { interactive: number; hasMain: boolean }>()
  const summarize = (node: FusedNode): { interactive: number; hasMain: boolean } => {
    const value = { interactive: Number(node.interactive), hasMain: node.role === 'main' }
    for (const child of node.children) { const stats = summarize(child); value.interactive += stats.interactive; value.hasMain ||= stats.hasMain }
    intent.set(node, value); return value
  }
  const total = tree.reduce((sum, node) => sum + summarize(node).interactive, 0)
  const pruneIntent = (nodes: FusedNode[]): FusedNode[] => nodes.filter((node) => {
    const matched = intentRules.some((rule) => rule.roles.includes(node.role) && (!rule.words || rule.words.some((word) => node.name.toLowerCase().includes(word))))
    const stats = intent.get(node)!
    return !matched || stats.hasMain || total > 0 && stats.interactive / total > 0.5
  }).map((node) => { node.children = pruneIntent(node.children); return node })
  tree = pruneIntent(tree)
  let budget = 4000
  const seen = new Set<string>(), significant = (node: FusedNode) => node.interactive || contentRoles.has(node.role) && !!node.name
  const pruneText = (nodes: FusedNode[], parentName?: string): FusedNode[] => nodes.filter((node) => {
    if (node.role !== 'StaticText') return true
    const text = clean(node.name)
    if (text.length < 2 || text === parentName || seen.has(text) || budget <= 0) return false
    node.name = text.slice(0, 300); budget -= node.name.length; seen.add(text); return true
  }).map((node) => { node.children = pruneText(node.children, significant(node) ? node.name : parentName); return node })
  tree = pruneText(tree)
  const compact = options.compact ?? options.efficient ?? true
  const structure = (nodes: FusedNode[], depth: number): FusedNode[] => nodes.flatMap((node) => {
    node.children = options.depth !== undefined && depth >= options.depth ? [] : structure(node.children, depth + 1)
    if (compact && !significant(node) && structuralRoles.has(node.role)) return collapsedRoles.has(node.role) ? node.children : node.children.length ? [node] : []
    return [node]
  })
  tree = structure(tree, 0)
  const rows: NativeRow[] = [], counts = new Map<string, number>(), seenIds = new Map<string, number>()
  const identity = (node: FusedNode) => `${node.frame.id}\0${node.role}\0${node.name}\0${node.placeholder?.trim() === node.name.trim() ? '' : node.placeholder?.trim() ?? ''}`
  const count = (node: FusedNode) => { if (significant(node)) { const key = identity(node); counts.set(key, (counts.get(key) ?? 0) + 1) } for (const child of node.children) count(child) }
  for (const node of tree) count(node)
  const render = (node: FusedNode, depth: number) => {
    const placeholder = node.placeholder?.trim() && node.placeholder.trim() !== node.name.trim() ? node.placeholder.trim() : undefined
    let nth: number | undefined
    if (significant(node) && (counts.get(identity(node)) ?? 0) > 1) { nth = seenIds.get(identity(node)) ?? 0; seenIds.set(identity(node), nth + 1) }
    const marks: string[] = []
    for (const key of ['checked', 'selected', 'expanded', 'pressed', 'disabled']) if (node.state[key] === true || node.state[key] === 'true') marks.push(key); else if (key === 'checked' && node.state[key] === 'mixed') marks.push('checked=mixed')
    if (node.state.value) marks.push(`value=${JSON.stringify(String(node.state.value))}`)
    const shown = !options.interactive || node.interactive
    const rowDepth = options.interactive ? 0 : depth
    if (shown) rows.push({ frame: node.frame, backendNodeId: significant(node) ? node.backendNodeId : undefined, role: node.role, name: node.name, placeholder, nth, interactive: node.interactive, depth: rowDepth, bounds: node.bounds ? { x: node.bounds[0], y: node.bounds[1], width: node.bounds[2], height: node.bounds[3] } : undefined, line: `${'  '.repeat(rowDepth)}- ${node.role === 'StaticText' ? 'text' : node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${placeholder ? ` [placeholder=${JSON.stringify(placeholder)}]` : ''}${marks.length ? ` [${marks.join(' ')}]` : ''}` })
    for (const child of node.children) render(child, depth + 1)
  }
  for (const node of tree) render(node, 0)
  return rows
}
