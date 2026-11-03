import type { BrowserActRequest } from '../browser-action-contract.js'
import { NativePageUpdatedError, type NativeFrame } from './native-snapshot.js'

export type NativeTarget = { backendNodeId: number; frame: NativeFrame }
export type NativeElementSession = {
  send: <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>
  contextId?: number
}
export type NativeElementTransport = {
  cursorKey?: object
  withFrameSession<T>(frameId: string | undefined, run: (session: NativeElementSession) => Promise<T>): Promise<T>
  assertCurrent(): void
}
export type NativeElementTarget = { ref?: string; backendNodeId?: number; frameId?: string }
export type NativeElementResult = { observedValue?: string; valueKind?: 'value' | 'text'; domChanged?: boolean }
type ElementRequest = BrowserActRequest | (NativeElementTarget & { kind: 'setChecked'; checked: boolean })
type Point = { x: number; y: number }
type Viewport = { width: number; height: number }
type Rect = Point & Viewport
type RemoteResult = { result?: { value?: any; objectId?: string; description?: string; subtype?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
type Element = { objectId: string; session: NativeElementSession; target: NativeTarget; transport: NativeElementTransport; actionPerformed?: boolean }
type FrameTree = { frame: { id: string; parentId?: string }; childFrames?: FrameTree[] }
const pointers = new WeakMap<object, Point>()

function guardedSession(session: NativeElementSession, transport: NativeElementTransport): NativeElementSession {
  return { contextId: session.contextId, send: async (method, params) => {
    transport.assertCurrent()
    const result = await session.send(method, params)
    transport.assertCurrent()
    return result
  } }
}

function isMissingBackend(error: unknown): boolean {
  return error instanceof Error && /No node with given id found|Could not find node with given id|No node found for given backend|Could not resolve node with given id|Node with given id does not belong to the document/iu.test(error.message)
}

function performedError(error: unknown): Error {
  const failure = error instanceof NativePageUpdatedError ? new Error('The page changed after native input; inspect it before deciding what to do next', { cause: error }) : error instanceof Error ? error : new Error(String(error))
  return Object.assign(failure, { actionPerformed: true, observationComplete: false })
}

async function releaseObjects(session: NativeElementSession, objectIds: string[], failed: boolean): Promise<void> {
  let cleanupError: unknown
  for (const objectId of new Set(objectIds)) {
    try { await session.send('Runtime.releaseObject', { objectId }) }
    catch (error) { cleanupError ??= error }
  }
  if (!failed && cleanupError !== undefined) throw cleanupError
}

async function withElement<T>(target: NativeTarget, transport: NativeElementTransport, run: (element: Element) => Promise<T>): Promise<T> {
  transport.assertCurrent()
  return transport.withFrameSession(target.frame.id, (session) => withResolvedElement(target, guardedSession(session, transport), transport, run))
}

async function withResolvedElement<T>(target: NativeTarget, session: NativeElementSession, transport: NativeElementTransport, run: (element: Element) => Promise<T>): Promise<T> {
  let objectId: string | undefined
  try {
    objectId = (await session.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
      backendNodeId: target.backendNodeId,
      ...(session.contextId === undefined ? {} : { executionContextId: session.contextId }),
    })).object?.objectId
  } catch (error) {
    transport.assertCurrent()
    if (isMissingBackend(error)) throw new NativePageUpdatedError('no_backend')
    throw error
  }
  if (!objectId) throw new NativePageUpdatedError('no_backend')
  let failed = false
  let failure: unknown
  let result!: T
  const element: Element = { objectId, session, target, transport }
  try {
    if (!await callElement<boolean>(element, 'return !!this.isConnected;')) throw new NativePageUpdatedError('no_backend')
    result = await run(element)
  } catch (error) { failed = true; failure = error }
  finally {
    try { await releaseObjects(session, [objectId], failed) }
    catch (error) { if (!failed) { failed = true; failure = error } }
  }
  if (failed) throw element.actionPerformed ? performedError(failure) : failure
  return result
}

async function callElement<T = any>(element: Element, body: string, args: unknown[] = []): Promise<T> {
  const response = await element.session.send<RemoteResult>('Runtime.callFunctionOn', {
    objectId: element.objectId,
    functionDeclaration: `function(...args){${body}}`,
    arguments: args.map((value) => ({ value })),
    returnByValue: true, awaitPromise: true, userGesture: true,
  })
  if (response.exceptionDetails || response.result?.subtype === 'error') {
    throw new Error(response.exceptionDetails?.exception?.description ?? response.exceptionDetails?.text ?? response.result?.description ?? 'Native element action failed')
  }
  return response.result?.value as T
}

async function pause(durationMs: number, transport: NativeElementTransport): Promise<void> {
  const until = Date.now() + durationMs
  do {
    transport.assertCurrent()
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(25, until - Date.now()))))
  } while (Date.now() < until)
  transport.assertCurrent()
}

function mapQuadPoint(quad: number[], x: number, y: number): Point {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad
  const dx = x0 - x1 + x2 - x3, dy = y0 - y1 + y2 - y3
  const denominator = (x1 - x2) * (y3 - y2) - (x3 - x2) * (y1 - y2)
  const g = denominator ? (dx * (y3 - y2) - (x3 - x2) * dy) / denominator : 0
  const h = denominator ? ((x1 - x2) * dy - dx * (y1 - y2)) / denominator : 0
  const scale = g * x + h * y + 1
  return { x: ((x1 - x0 + g * x1) * x + (x3 - x0 + h * x3) * y + x0) / scale, y: ((y1 - y0 + g * y1) * x + (y3 - y0 + h * y3) * y + y0) / scale }
}

async function hitTarget(element: Element, point: Point): Promise<boolean> {
  return callElement(element, `const roots=[];let owner=this;while(owner){const root=owner.getRootNode();roots.push(root);owner=root.host;}let hit=null;for(const root of roots.reverse()){const found=root.elementFromPoint?.(args[0].x,args[0].y);if(!found)return false;if(hit&&found!==hit&&found.getRootNode().host!==hit)return false;hit=found;}let node=hit;for(let index=0;index<500&&node;index++){if(node===this)return true;node=node.parentNode??node.host??null;}if(!hit)return false;const r=hit.getBoundingClientRect();return Math.abs(r.x+r.width/2-args[0].x)<=2&&Math.abs(r.y+r.height/2-args[0].y)<=2;`, [point])
}

async function frameParents(root: NativeElementSession): Promise<Map<string, string | undefined>> {
  const { frameTree } = await root.send<{ frameTree: FrameTree }>('Page.getFrameTree')
  const parents = new Map<string, string | undefined>()
  const visit = (tree: FrameTree, parentId?: string) => {
    parents.set(tree.frame.id, tree.frame.parentId ?? parentId)
    for (const child of tree.childFrames ?? []) visit(child, tree.frame.id)
  }
  visit(frameTree)
  return parents
}

async function rootPoints(element: Element, points: Point[], root: NativeElementSession, checkHit: boolean, scrollFrame = false): Promise<Point[]> {
  const parents = await frameParents(root)
  const frameId = element.target.frame.id
  if (!parents.has(frameId)) throw new Error(`Native frame is no longer live: ${frameId}`)
  const viewport = await callElement<Viewport>(element, 'return {width:innerWidth,height:innerHeight};')
  const map = async (id: string, local: Point[], size: Viewport): Promise<Point[]> => {
    const parentId = parents.get(id)
    if (!parentId) return local
    return element.transport.withFrameSession(parentId, async (rawSession) => {
      const session = guardedSession(rawSession, element.transport)
      const owner = await session.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: id })
      return withResolvedElement({ backendNodeId: owner.backendNodeId, frame: { ...element.target.frame, id: parentId, parentId: parents.get(parentId) } }, session, element.transport, async (ownerElement) => {
        if (scrollFrame) await session.send('DOM.scrollIntoViewIfNeeded', { objectId: ownerElement.objectId })
        const { model } = await session.send<{ model: { border: number[]; content: number[] } }>('DOM.getBoxModel', { objectId: ownerElement.objectId })
        const localOwner = await callElement<Rect & { viewport: Viewport }>(ownerElement, 'const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:{width:innerWidth,height:innerHeight}};')
        const offsetX = Math.min(model.border[0], model.border[2], model.border[4], model.border[6]) - localOwner.x
        const offsetY = Math.min(model.border[1], model.border[3], model.border[5], model.border[7]) - localOwner.y
        const quad = model.content.map((value, index) => value - (index % 2 ? offsetY : offsetX))
        if (!(size.width > 0 && size.height > 0)) throw new Error('Native frame has no viewport')
        const mapped = local.map((point) => mapQuadPoint(quad, point.x / size.width, point.y / size.height))
        if (checkHit) for (const point of mapped) if (!await hitTarget(ownerElement, point)) throw new Error('An ancestor frame is obscured')
        return map(parentId, mapped, localOwner.viewport)
      })
    })
  }
  const mapped = await map(frameId, points, viewport)
  if (mapped.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error('Native frame coordinates are invalid')
  return mapped
}

async function elementCenter(element: Element): Promise<Point | null> {
  const connected = await callElement<boolean>(element, 'return !!this.isConnected;')
  if (!connected) return null
  const { model } = await element.session.send<{ model?: { content: number[]; border: number[]; width: number; height: number } }>('DOM.getBoxModel', { objectId: element.objectId })
  if (!model || model.content.length < 8 || !(model.width > 0 && model.height > 0)) return null
  // CDP quads may be relative to the target's session root; normalize to this frame before mapping.
  const rect = await callElement<Rect>(element, 'const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};')
  const offsetX = Math.min(model.border[0], model.border[2], model.border[4], model.border[6]) - rect.x
  const offsetY = Math.min(model.border[1], model.border[3], model.border[5], model.border[7]) - rect.y
  return { x: (model.content[0] + model.content[2] + model.content[4] + model.content[6]) / 4 - offsetX, y: (model.content[1] + model.content[3] + model.content[5] + model.content[7]) / 4 - offsetY }
}

function isOutside(point: Point, viewport: Viewport): boolean {
  return point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height
}

async function stableCenter(element: Element): Promise<Point | null> {
  let previous = await elementCenter(element)
  for (let attempt = 0; attempt < 8; attempt++) {
    await pause(30, element.transport)
    const point = await elementCenter(element)
    if (!point) return null
    if (previous && Math.abs(previous.x - point.x) <= 2 && Math.abs(previous.y - point.y) <= 2) return point
    previous = point
  }
  return previous
}

const scrollElementBody = `
  let r=this.getBoundingClientRect();if(r.width<=0||r.height<=0)return;
  const canScroll=(el,axis)=>{if(!el||el===document.body||el===document.documentElement)return false;const s=getComputedStyle(el),overflow=axis==='y'?s.overflowY:s.overflowX;return /(auto|scroll|overlay)/.test(overflow)&&(axis==='y'?el.scrollHeight>el.clientHeight+1:el.scrollWidth>el.clientWidth+1);};
  const bandFor=size=>Math.min(Math.max(24,Math.round(size*.15)),Math.max(24,Math.floor(size/2)));
  for(let parent=this.parentElement;parent;parent=parent.parentElement){let changed=false;for(const axis of ['y','x']){if(!canScroll(parent,axis))continue;const p=parent.getBoundingClientRect(),vertical=axis==='y',band=bandFor(vertical?p.height:p.width),center=vertical?r.y+r.height/2:r.x+r.width/2,low=(vertical?p.top:p.left)+band,high=(vertical?p.bottom:p.right)-band,delta=center<low?center-low:center>high?center-high:0;if(delta){if(vertical)parent.scrollTop=Math.max(0,Math.min(parent.scrollTop+delta,parent.scrollHeight-parent.clientHeight));else parent.scrollLeft=Math.max(0,Math.min(parent.scrollLeft+delta,parent.scrollWidth-parent.clientWidth));changed=true;}}if(changed)r=this.getBoundingClientRect();}
  const root=document.scrollingElement||document.documentElement,band=Math.max(60,Math.round(innerHeight*.15)),cy=r.y+r.height/2,cx=r.x+r.width/2;
  let dy=cy<band?cy-band:cy>innerHeight-band?cy-(innerHeight-band):0,dx=cx<0?cx-band:cx>innerWidth?cx-(innerWidth-band):0;
  let y=scrollY+dy,x=scrollX+dx;const anchor=args[0];
  if(anchor&&dy){const a=anchor.y+scrollY;if(dy>0&&a-y<band)y=a-band;else if(dy<0&&a-y>innerHeight-band)y=a-(innerHeight-band);}
  if(anchor&&dx){const a=anchor.x+scrollX;if(dx>0&&a-x<band)x=a-band;else if(dx<0&&a-x>innerWidth-band)x=a-(innerWidth-band);}
  window.scrollTo(Math.max(0,Math.min(x,Math.max(0,root.scrollWidth-innerWidth))),Math.max(0,Math.min(y,Math.max(0,root.scrollHeight-innerHeight))));
`

function unmapQuadPoint(quad: number[], point: Point): Point {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad
  const dx = x0 - x1 + x2 - x3, dy = y0 - y1 + y2 - y3
  const denominator = (x1 - x2) * (y3 - y2) - (x3 - x2) * (y1 - y2)
  const g = denominator ? (dx * (y3 - y2) - (x3 - x2) * dy) / denominator : 0
  const h = denominator ? ((x1 - x2) * dy - dx * (y1 - y2)) / denominator : 0
  const a = x1 - x0 + g * x1 - point.x * g, b = x3 - x0 + h * x3 - point.x * h
  const c = y1 - y0 + g * y1 - point.y * g, d = y3 - y0 + h * y3 - point.y * h
  const determinant = a * d - b * c
  return { x: ((point.x - x0) * d - b * (point.y - y0)) / determinant, y: (a * (point.y - y0) - (point.x - x0) * c) / determinant }
}

async function hoverAnchor(element: Element, root: NativeElementSession, viewport: Viewport): Promise<Element | undefined> {
  const pointer = pointers.get(element.transport.cursorKey ?? element.transport)
  if (!pointer) return
  const corners = await rootPoints(element, [{ x: 0, y: 0 }, { x: viewport.width, y: 0 }, { x: viewport.width, y: viewport.height }, { x: 0, y: viewport.height }], root, false)
  const unit = unmapQuadPoint(corners.flatMap((point) => [point.x, point.y]), pointer)
  const point = { x: unit.x * viewport.width, y: unit.y * viewport.height }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || isOutside(point, viewport)) return
  const response = await element.session.send<RemoteResult>('Runtime.callFunctionOn', { objectId: element.objectId, functionDeclaration: 'function(x,y){return this.ownerDocument.elementFromPoint(x,y);}', arguments: [{ value: Math.round(point.x) }, { value: Math.round(point.y) }], returnByValue: false })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Hover anchor resolution failed')
  const objectId = response.result?.objectId
  if (!objectId) return
  try {
    const description = await element.session.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId })
    if (description.node.backendNodeId !== element.target.backendNodeId) return { ...element, objectId, target: { ...element.target, backendNodeId: description.node.backendNodeId } }
  } catch (error) {
    await releaseObjects(element.session, [objectId], true)
    throw error
  }
  await releaseObjects(element.session, [objectId], false)
}

async function actionablePoint(element: Element, root: NativeElementSession): Promise<{ local: Point; root: Point }> {
  const previous = await elementCenter(element)
  if (!previous) throw new Error('Native element is invisible')
  await pause(24, element.transport)
  let point = await elementCenter(element)
  if (!point) throw new Error('Native element is invisible')
  if (Math.abs(previous.x - point.x) > 2 || Math.abs(previous.y - point.y) > 2) throw new Error('Native element is not stable')
  let viewport = await callElement<Viewport>(element, 'return {width:innerWidth,height:innerHeight};')
  if (isOutside(point, viewport)) {
    const anchor = await hoverAnchor(element, root, viewport)
    let failed = false
    try {
      const anchorPoint = anchor ? await elementCenter(anchor) : null
      await callElement(element, scrollElementBody, [anchorPoint])
      point = await stableCenter(element)
      viewport = await callElement<Viewport>(element, 'return {width:innerWidth,height:innerHeight};')
      if (point && isOutside(point, viewport)) {
        await callElement(element, `const {x,y}=args[0],band=Math.max(60,Math.round(innerHeight*.15)),root=document.scrollingElement||document.documentElement;const dy=y<band?y-band:y>innerHeight-band?y-(innerHeight-band):0,dx=x<0?x-band:x>innerWidth?x-(innerWidth-band):0;if(dx||dy)window.scrollTo(Math.max(0,Math.min(scrollX+dx,Math.max(0,root.scrollWidth-innerWidth))),Math.max(0,Math.min(scrollY+dy,Math.max(0,root.scrollHeight-innerHeight))));`, [previous])
        point = await stableCenter(element)
        viewport = await callElement<Viewport>(element, 'return {width:innerWidth,height:innerHeight};')
      }
      if (!point && anchor) {
        const anchorCenter = await elementCenter(anchor)
        if (anchorCenter && !isOutside(anchorCenter, viewport)) {
          await movePointer(root, (await rootPoints(anchor, [anchorCenter], root, true))[0], element.transport)
          await pause(120, element.transport)
          let last: Point | null = null
          for (let attempt = 0; attempt < 8; attempt++) {
            const current = await elementCenter(element)
            if (current && last && Math.abs(current.x - last.x) <= 2 && Math.abs(current.y - last.y) <= 2) { point = current; break }
            last = current
            await pause(200, element.transport)
          }
          if (point && !isOutside(point, viewport)) {
            await movePointer(root, (await rootPoints(element, [point], root, true))[0], element.transport)
            await pause(120, element.transport)
            point = await elementCenter(element)
          }
        }
      }
      if (!point || isOutside(point, viewport)) throw new Error(anchor ? 'Native hover anchor was lost or the target is offscreen' : 'Native element is outside the viewport')
    } catch (error) { failed = true; throw error }
    finally { if (anchor) await releaseObjects(element.session, [anchor.objectId], failed) }
  }
  if (!await hitTarget(element, point)) throw new Error('Native element is obscured')
  const mapped = (await rootPoints(element, [point], root, true, true))[0]
  // Scrolling an ancestor can move the local target as well; never dispatch at an old point.
  const current = await elementCenter(element)
  if (!current || Math.abs(current.x - point.x) > 2 || Math.abs(current.y - point.y) > 2) throw new Error('Native element moved while scrolling its frame')
  return { local: point, root: mapped }
}

async function movePointer(root: NativeElementSession, point: Point, transport: NativeElementTransport, humanize = false, modifiers = 0): Promise<boolean> {
  const previous = pointers.get(transport.cursorKey ?? transport)
  const distance = previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0
  const steps = previous && distance >= 50 ? Math.min(20, Math.max(2, Math.ceil(distance / 60))) : 1
  for (let step = 1; step <= steps; step++) {
    const fraction = step / steps, jitter = humanize && step < steps ? (Math.random() - .5) * 4 : 0
    await root.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: previous ? previous.x + (point.x - previous.x) * fraction - (point.y - previous.y) / (distance || 1) * jitter : point.x, y: previous ? previous.y + (point.y - previous.y) * fraction + (point.x - previous.x) / (distance || 1) * jitter : point.y, modifiers })
    if (step < steps) await pause(humanize ? 6 + Math.random() * 8 : 8, transport)
  }
  pointers.set(transport.cursorKey ?? transport, point)
  return steps > 1
}

export async function moveNativePointer(point: Point, transport: NativeElementTransport, modifiers: string[] = []): Promise<void> {
  return transport.withFrameSession(undefined, async (rawRoot) => {
    const bits = modifiers.reduce((value, name) => value | (modifierKeys[name === 'ControlOrMeta' ? process.platform === 'darwin' ? 'Meta' : 'Control' : name]?.bit ?? 0), 0)
    if (await movePointer(guardedSession(rawRoot, transport), point, transport, true, bits)) await pause(60, transport)
  })
}

const modifierKeys: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; bit: number }> = {
  Alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, bit: 1 },
  Control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, bit: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, bit: 4 },
  Shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, bit: 8 },
}

async function clickElement(element: Element, root: NativeElementSession, options: { button?: 'left' | 'middle' | 'right'; doubleClick?: boolean; modifiers?: string[]; humanize?: boolean } = {}): Promise<void> {
  const point = await actionablePoint(element, root)
  const modifiers = [...new Set(options.modifiers ?? [])].map((name) => modifierKeys[name === 'ControlOrMeta' ? process.platform === 'darwin' ? 'Meta' : 'Control' : name]).filter((key) => !!key)
  const button = options.button ?? 'left', buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4
  let bits = 0, failed = false
  let failure: unknown
  const held: typeof modifiers = []
  try {
    for (const modifier of modifiers) {
      bits |= modifier.bit
      await root.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.windowsVirtualKeyCode, modifiers: bits })
      held.push(modifier)
    }
    if (await movePointer(root, point.root, element.transport, options.humanize, bits)) await pause(60, element.transport)
    if (!await hitTarget(element, point.local)) throw new Error('Native element became obscured after hover')
    const current = (await rootPoints(element, [point.local], root, true))[0]
    if (Math.abs(current.x - point.root.x) > .5 || Math.abs(current.y - point.root.y) > .5) throw new Error('Native frame moved after hover')
    let clickPoint = point.root
    if (options.humanize) {
      const jitter = { x: point.local.x + (Math.random() - .5) * 6, y: point.local.y + (Math.random() - .5) * 6 }
      if (await hitTarget(element, jitter)) clickPoint = (await rootPoints(element, [jitter], root, true))[0]
    }
    const clickCount = options.doubleClick ? 2 : 1
    await root.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...clickPoint, button, buttons, clickCount, modifiers: bits })
    let inputFailed = false
    let inputFailure: unknown
    try { if (options.humanize) await pause(30 + Math.random() * 60, element.transport) }
    catch (error) { inputFailed = true; inputFailure = error }
    finally {
      try {
        await root.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...clickPoint, button, buttons: 0, clickCount, modifiers: bits })
        element.actionPerformed = true
      } catch (error) { if (!inputFailed) { inputFailed = true; inputFailure = error } }
    }
    if (inputFailed) throw inputFailure
  } catch (error) { failed = true; failure = error }
  finally {
    for (const modifier of held.reverse()) {
      bits &= ~modifier.bit
      try { await root.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.windowsVirtualKeyCode, modifiers: bits }) }
      catch (error) { if (!failed) { failed = true; failure = error } }
    }
  }
  if (failed) throw failure
}

async function pressKey(root: NativeElementSession, key: 'Enter' | 'Backspace' | 'Delete'): Promise<void> {
  const windowsVirtualKeyCode = key === 'Enter' ? 13 : key === 'Backspace' ? 8 : 46
  await root.send('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', key, code: key, windowsVirtualKeyCode, ...(key === 'Enter' ? { text: '\r' } : {}) })
  await root.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode })
}

type EditableValue = { kind: 'value' | 'text'; value: string }
const readEditableBody = `if(this.tagName==='INPUT'||this.tagName==='TEXTAREA')return {kind:'value',value:String(this.value||'')};if(this.isContentEditable)return {kind:'text',value:String(this.innerText||this.textContent||'')};return null;`
const setEditableBody = `if(args[1]&&(this.tagName!=='INPUT'||!['date','time','datetime-local','month','week','color','range'].includes(String(this.getAttribute('type')||'').toLowerCase())))return false;const proto=this.tagName==='INPUT'?window.HTMLInputElement?.prototype:this.tagName==='TEXTAREA'?window.HTMLTextAreaElement?.prototype:null;if(!proto)return false;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;this.focus();if(setter)setter.call(this,args[0]);else this.value=args[0];this._valueTracker?.setValue('\u0000_stale_');this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));if(args[1])this.dispatchEvent(new FocusEvent('blur'));return args[1]||this.value===args[0];`

async function typeElement(element: Element, root: NativeElementSession, request: Extract<BrowserActRequest, { kind: 'type' }>, humanize: boolean): Promise<NativeElementResult> {
  if (typeof request.text !== 'string') throw new Error('text is required')
  const text = request.text, clearFirst = request.clearFirst !== false
  await clickElement(element, root, { humanize: false })
  await element.session.send('DOM.focus', { objectId: element.objectId })
  if (await callElement<boolean>(element, setEditableBody, [text, true])) return {}
  if (clearFirst) {
    const selection = await callElement<{ input: boolean; length?: number }>(element, `if(this.tagName==='INPUT'||this.tagName==='TEXTAREA'){try{this.focus();const length=String(this.value||'').length;if(length)this.setSelectionRange(0,length);return {input:true,length};}catch{return {input:false};}}return {input:false};`)
    if (selection.input) {
      if (selection.length) await pressKey(root, 'Backspace')
      if ((await callElement<EditableValue | null>(element, readEditableBody))?.value) await callElement(element, setEditableBody, ['', false])
    } else {
      const modifiers = process.platform === 'darwin' ? 4 : 2
      await root.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
      await root.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
      await pressKey(root, 'Delete')
    }
  }
  if (humanize || request.slowly) for (const character of text) {
    await root.send('Input.insertText', { text: character })
    await pause(humanize ? 45 + Math.random() * 65 : 75, element.transport)
  }
  else await root.send('Input.insertText', { text })
  await callElement(element, `if(this.tagName==='INPUT'||this.tagName==='TEXTAREA')this._valueTracker?.setValue('\u0000_stale_');this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));`)
  let observed = await callElement<EditableValue | null>(element, readEditableBody)
  const accepted = !observed || (clearFirst ? observed.value === text : text === '' || observed.value.endsWith(text))
  if (!accepted) {
    if (observed?.kind !== 'value' || !await callElement<boolean>(element, setEditableBody, [text, false])) throw new Error(`Typed text was not accepted by the target (expected length ${text.length}, observed length ${observed?.value.length ?? 0})`)
    observed = await callElement<EditableValue | null>(element, readEditableBody)
    if (observed && observed.value !== text) throw new Error(`Typed text was not accepted by the target (expected length ${text.length}, observed length ${observed.value.length})`)
  }
  if (request.submit) await pressKey(root, 'Enter')
  return observed ? { observedValue: observed.value, valueKind: observed.kind } : {}
}

async function selectElement(element: Element, values: string[] | undefined): Promise<void> {
  if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string')) throw new Error('A non-empty values array is required')
  const result = await callElement<string>(element, `if(this.tagName!=='SELECT')return 'no_match';let matched=false;for(const option of this.options){const hit=args[0].includes(option.value)||args[0].includes(option.label)||args[0].includes(option.text);option.selected=hit;if(hit)matched=true;}if(!matched)return 'no_match';this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));for(const option of this.options)if(option.selected&&(args[0].includes(option.value)||args[0].includes(option.label)||args[0].includes(option.text)))return 'ok';return 'reverted';`, [values])
  element.actionPerformed = true
  if (result !== 'ok') throw new Error(result === 'reverted' ? `Selection of ${JSON.stringify(values)} was reverted by the page` : `No <option> matched value(s) ${JSON.stringify(values)}`)
}

async function dragElements(request: Extract<BrowserActRequest, { kind: 'drag' }>, resolve: (target: NativeElementTarget) => Promise<NativeTarget>, transport: NativeElementTransport, root: NativeElementSession): Promise<void> {
  if (!request.startRef?.trim()) throw new Error('startRef is required')
  if (request.endRef && (request.endX !== undefined || request.endY !== undefined)) throw new Error('Use an end ref or coordinates, not both')
  const steps = request.steps ?? 10, durationMs = request.durationMs ?? 400
  if (!Number.isInteger(steps) || steps < 1 || steps > 60 || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10_000) throw new Error('Drag steps must be 1–60 and durationMs 0–10000')
  const source = await resolve({ ref: request.startRef })
  const target = request.endRef ? await resolve({ ref: request.endRef }) : undefined
  const drag = async (sourceElement: Element, targetElement?: Element) => {
    // Prepare the destination first; source scrolling can invalidate it, so re-read both points before pressing.
    if (targetElement) await actionablePoint(targetElement, root)
    const from = await actionablePoint(sourceElement, root)
    const to = targetElement ? await actionablePoint(targetElement, root) : { root: { x: request.endX!, y: request.endY! } }
    const current = (await rootPoints(sourceElement, [from.local], root, true))[0]
    if (Math.abs(current.x - from.root.x) > .5 || Math.abs(current.y - from.root.y) > .5) throw new Error('Drag source moved while preparing the destination')
    if (![to.root.x, to.root.y].every(Number.isFinite)) throw new Error('Drag requires an end ref or finite end coordinates')
    const metrics = await root.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number }; visualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics')
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
    if (isOutside(to.root, { width: viewport.clientWidth, height: viewport.clientHeight })) throw new Error('Drag destination is outside the viewport')
    await movePointer(root, from.root, transport)
    if (!await hitTarget(sourceElement, from.local)) throw new Error('Drag source became obscured after hover')
    let point = from.root, pressed = false, failed = false
    let failure: unknown
    try {
      await root.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
      pressed = true
      for (let step = 1; step <= steps; step++) {
        if (durationMs) await pause(durationMs / steps, transport)
        point = { x: from.root.x + (to.root.x - from.root.x) * step / steps, y: from.root.y + (to.root.y - from.root.y) * step / steps }
        await root.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1 })
        pointers.set(transport.cursorKey ?? transport, point)
      }
    } catch (error) { failed = true; failure = error }
    finally {
      if (pressed) try {
        await root.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
        sourceElement.actionPerformed = true
      } catch (error) { if (!failed) { failed = true; failure = error } }
    }
    if (failed) throw failure
  }
  await withElement(source, transport, async (sourceElement) => target ? withElement(target, transport, (targetElement) => drag(sourceElement, targetElement)) : drag(sourceElement))
}

async function domSignature(root: NativeElementSession): Promise<string> {
  const response = await root.send<RemoteResult>('Runtime.evaluate', { expression: `[document.getElementsByTagName('*').length,document.documentElement.scrollHeight,document.body?.lastElementChild?document.body.lastElementChild.tagName+'|'+(document.body.lastElementChild.id||'')+'|'+String(document.body.lastElementChild.className||'').slice(0,80):''].join('#')`, ...(root.contextId === undefined ? {} : { contextId: root.contextId }), returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'DOM observation failed')
  if (typeof response.result?.value !== 'string') throw new Error('DOM observation did not return a signature')
  return response.result.value
}

export async function actNativeElement(request: ElementRequest, resolve: (target: NativeElementTarget) => Promise<NativeTarget>, transport: NativeElementTransport, humanize = request.kind === 'click' && request.humanize === true): Promise<NativeElementResult> {
  transport.assertCurrent()
  return transport.withFrameSession(undefined, async (rawRoot) => {
    const root = guardedSession(rawRoot, transport)
    if (request.kind === 'drag') {
      const before = await domSignature(root)
      await dragElements(request, resolve, transport, root)
      try { return before !== await domSignature(root) ? { domChanged: true } : {} }
      catch (error) { throw performedError(error) }
    }
    if (!['click', 'type', 'hover', 'scrollIntoView', 'select', 'setChecked'].includes(request.kind ?? '')) throw new Error(`Unsupported native element action: ${request.kind}`)
    const targetInput = request as NativeElementTarget
    const target = await resolve({ ref: targetInput.ref, backendNodeId: targetInput.backendNodeId, frameId: targetInput.frameId })
    const before = request.kind === 'click' || request.kind === 'type' ? await domSignature(root) : undefined
    const result = await withElement(target, transport, async (element): Promise<NativeElementResult> => {
      switch (request.kind) {
        case 'click': await clickElement(element, root, { ...request, humanize }); return {}
        case 'type': return typeElement(element, root, request, humanize)
        case 'select': await selectElement(element, request.values); return {}
        case 'setChecked': {
          if (await callElement<boolean>(element, 'return !!this.checked;') !== request.checked) {
            await clickElement(element, root, { humanize })
            if (await callElement<boolean>(element, 'return !!this.checked;') !== request.checked) throw new Error('Checkbox/radio did not reach the requested state')
          }
          return {}
        }
        case 'scrollIntoView': await element.session.send('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId }); element.actionPerformed = true; return {}
        case 'hover': {
          const point = await actionablePoint(element, root)
          const textPoint = await callElement<Point | null>(element, `let best=null,area=Infinity,visited=0;const walk=el=>{if(visited++>800)return;let own='';for(const node of el.childNodes)if(node.nodeType===3)own+=node.textContent;if(own.trim()){const r=el.getBoundingClientRect(),style=getComputedStyle(el);if(r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&r.width*r.height<area){area=r.width*r.height;best={x:r.left+r.width/2,y:r.top+r.height/2};}}for(const child of el.children)walk(child);};walk(this);return best;`)
          const local = textPoint && await hitTarget(element, textPoint) ? textPoint : point.local
          const mapped = (await rootPoints(element, [local], root, true))[0]
          if (await movePointer(root, mapped, transport, humanize)) await pause(60, transport)
          element.actionPerformed = true
          return {}
        }
        default: throw new Error('Native element action is not supported')
      }
    })
    try { return before !== undefined && before !== await domSignature(root) ? { ...result, domChanged: true } : result }
    catch (error) { throw performedError(error) }
  })
}

export async function evaluateNativeElement(target: NativeTarget, fnBody: string, transport: NativeElementTransport): Promise<unknown> {
  if (!fnBody.trim()) throw new Error('fn is required')
  return withElement(target, transport, (element) => callElement(element, `const candidate=eval('('+args[0]+')');return typeof candidate==='function'?candidate(this):candidate;`, [fnBody]))
}

export async function screenshotNativeElementClip(target: NativeTarget, transport: NativeElementTransport): Promise<Rect> {
  return transport.withFrameSession(undefined, async (rawRoot) => {
    const root = guardedSession(rawRoot, transport)
    return withElement(target, transport, async (element) => {
      await element.session.send('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId })
      const { model } = await element.session.send<{ model: { border: number[] } }>('DOM.getBoxModel', { objectId: element.objectId })
      const rect = await callElement<Rect>(element, 'const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};')
      if (!(rect.width > 0 && rect.height > 0)) throw new Error('Screenshot element has no visible dimensions')
      const offsetX = Math.min(model.border[0], model.border[2], model.border[4], model.border[6]) - rect.x
      const offsetY = Math.min(model.border[1], model.border[3], model.border[5], model.border[7]) - rect.y
      const corners = [0, 2, 4, 6].map((index) => ({ x: model.border[index] - offsetX, y: model.border[index + 1] - offsetY }))
      const points = await rootPoints(element, corners, root, false, true)
      const metrics = await root.send<{ cssVisualViewport?: { pageX: number; pageY: number }; visualViewport: { pageX: number; pageY: number } }>('Page.getLayoutMetrics')
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
      const x = Math.min(...points.map((point) => point.x)), y = Math.min(...points.map((point) => point.y))
      return { x: x + viewport.pageX, y: y + viewport.pageY, width: Math.max(...points.map((point) => point.x)) - x, height: Math.max(...points.map((point) => point.y)) - y }
    })
  })
}

export async function setNativeInputFiles(target: NativeTarget, paths: string[], transport: NativeElementTransport): Promise<void> {
  if (!paths.length) throw new Error('Upload requires at least one file path')
  await withElement(target, transport, async (element) => {
    const response = await element.session.send<RemoteResult>('Runtime.callFunctionOn', {
      objectId: element.objectId,
      functionDeclaration: `function(){const isFileInput=node=>node&&node.tagName==='INPUT'&&String(node.getAttribute('type')||'').toLowerCase()==='file';const descendants=(node,depth)=>{if(!node||depth<0)return null;if(isFileInput(node))return node;for(const child of node.children||[]){const found=descendants(child,depth-1);if(found)return found;}return null;};let current=this;for(let height=0;height<=3&&current;height++){if(isFileInput(current))return current;const found=descendants(current,3);if(found)return found;const parent=current.parentElement;if(parent)for(const sibling of parent.children){if(sibling===current)continue;const nearby=descendants(sibling,3);if(nearby)return nearby;}current=parent;}return null;}`,
      returnByValue: false,
    })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'File input resolution failed')
    const objectId = response.result?.objectId
    if (!objectId || response.result?.subtype === 'null') throw new Error('No file input found near ref')
    let failed = false
    try {
      await element.session.send('DOM.setFileInputFiles', { objectId, files: paths })
      element.actionPerformed = true
      await callElement({ ...element, objectId }, `this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));`)
    } catch (error) { failed = true; throw error }
    finally { await releaseObjects(element.session, [objectId], failed) }
  })
}

export async function highlightNativeElement(target: NativeTarget, durationMs: number, transport: NativeElementTransport): Promise<void> {
  const duration = Math.max(500, Math.min(10_000, Number.isFinite(durationMs) ? durationMs : 2_000))
  await withElement(target, transport, (element) => callElement<void>(element, `const previous=this.style.cssText;this.style.outline='3px solid #FF4500';this.style.outlineOffset='2px';setTimeout(()=>{this.style.cssText=previous;},args[0]);`, [duration]))
}
