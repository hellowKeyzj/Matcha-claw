import type { BrowserUtilityRequest } from '../browser-action-contract.js'
import { checkSnapshotFailure } from './native-snapshot.js'
import type { NativeFrame, NativeRow, NativeScope, NativeSnapshotOptions, NativeTransport } from './native-snapshot.js'
import { interactiveRoles, readAccessibility, type AxNode } from './native-snapshot-dom.js'

const clean = (value: unknown, max: number) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)

async function scopedBackendIds(transport: NativeTransport, frame: NativeFrame, scope: NativeScope): Promise<Set<number> | undefined> {
  if (!scope.roots) return undefined
  const roots = scope.roots.get(frame.id)
  if (!roots) return new Set()
  const allowed = new Set<number>()
  for (const backendNodeId of roots) {
    const { node } = await transport.send<any>('DOM.describeNode', { backendNodeId, depth: -1, pierce: true }, frame.sessionId)
    const visit = (node: any) => {
      if (typeof node?.backendNodeId === 'number') allowed.add(node.backendNodeId)
      for (const child of [...(node?.children ?? []), ...(node?.shadowRoots ?? []), ...(node?.pseudoElements ?? []), ...(node?.contentDocument ? [node.contentDocument] : [])]) visit(child)
    }
    visit(node)
  }
  return allowed
}

async function scopedFrames(transport: NativeTransport, scope: NativeScope): Promise<Map<string, Set<number> | undefined>> {
  const allowed = new Map<string, Set<number> | undefined>()
  const visit = async (frame: NativeFrame): Promise<Set<number> | undefined> => {
    if (allowed.has(frame.id)) return allowed.get(frame.id)
    const parent = scope.frames.find((candidate) => candidate.id === frame.parentId)
    if (scope.roots && parent) {
      const parentNodes = await visit(parent)
      const owner = await transport.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId: frame.id }, parent.sessionId)
      if (!parentNodes || owner.backendNodeId !== undefined && parentNodes.has(owner.backendNodeId)) { allowed.set(frame.id, undefined); return }
    }
    const nodes = await scopedBackendIds(transport, frame, scope)
    allowed.set(frame.id, nodes); return nodes
  }
  for (const frame of scope.frames) await visit(frame)
  return allowed
}

async function accessibilityRows(transport: NativeTransport, scope: NativeScope, options: NativeSnapshotOptions): Promise<NativeRow[]> {
  const groups = await readAccessibility(transport, scope.frames), rows: NativeRow[] = []
  const selected = await scopedFrames(transport, scope)
  for (const { frame, nodes } of groups) {
    const allowed = selected.get(frame.id)
    const byId = new Map(nodes.map((node) => [node.nodeId, node])), children = new Set(nodes.flatMap((node) => node.childIds ?? [])), visited = new Set<string>()
    const visit = (node: typeof nodes[number], depth: number) => {
      if (visited.has(node.nodeId)) return
      visited.add(node.nodeId)
      const role = clean(node.role?.value, 80), name = clean(node.name?.value, 80), value = clean(node.value?.value, 40)
      const backendNodeId = node.backendDOMNodeId, interactive = interactiveRoles.has(role)
      if (!node.ignored && role !== 'InlineTextBox' && role !== 'none' && (name || value || backendNodeId)
        && (!allowed || backendNodeId !== undefined && allowed.has(backendNodeId)) && (!options.interactive || interactive)) {
        const marks: string[] = []
        for (const property of node.properties ?? []) {
          const value = property.value?.value, key = property.name
          if (['disabled', 'hidden', 'invisible', 'offscreen', 'focusable', 'focused', 'editable', 'readonly', 'required', 'modal', 'busy', 'selected'].includes(key) && value === true) marks.push(key)
          else if (['checked', 'pressed'].includes(key) && (value === true || value === 'mixed')) marks.push(value === true ? key : `${key}=mixed`)
          else if (key === 'expanded' && typeof value === 'boolean') marks.push(value ? 'expanded' : 'collapsed')
          else if (['hasPopup', 'popup', 'current', 'invalid', 'level', 'placeholder', 'errorMessage'].includes(key) && value !== false && value !== 'false' && value !== 'none' && value !== undefined) marks.push(`${key}=${clean(value, 40)}`)
        }
        const rowDepth = options.interactive ? 0 : depth
        rows.push({ frame, backendNodeId, role, name, interactive, depth: rowDepth, line: `${'  '.repeat(rowDepth)}- ${role || 'unknown'}${name ? ` ${JSON.stringify(name)}` : ''}${value ? ` value=${JSON.stringify(value)}` : ''}${backendNodeId ? ` [dom=${backendNodeId}]` : ''}${marks.length ? ` [${marks.join(' ')}]` : ''}` })
      }
      if (options.depth === undefined || depth < options.depth) for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) visit(child, depth + 1) }
    }
    for (const node of nodes) if (!children.has(node.nodeId)) visit(node, 0)
  }
  return rows
}

async function liveDomRows(transport: NativeTransport, scope: NativeScope, options: NativeSnapshotOptions, frames: NativeFrame[], selected: Map<string, Set<number> | undefined>): Promise<NativeRow[]> {
  const rows: NativeRow[] = []
  for (const frame of frames) {
    const included = selected.get(frame.id)
    if (included?.size === 0) continue
    const roots = included ? scope.roots?.get(frame.id) : undefined
    await transport.withFrameSession(frame.id, async ({ send, contextId }) => {
      for (const backendNodeId of roots ?? [undefined]) {
        const objects = new Set<string>()
        try {
          const response = backendNodeId === undefined
            ? await send('Runtime.evaluate', { expression: 'document.body||document.documentElement', ...(contextId === undefined ? {} : { contextId }), returnByValue: false })
            : await send('DOM.resolveNode', { backendNodeId, ...(contextId === undefined ? {} : { executionContextId: contextId }) })
          const rootId = response.result?.objectId ?? response.object?.objectId
          if (!rootId) continue
          objects.add(rootId)
          const result = await send('Runtime.callFunctionOn', { objectId: rootId, functionDeclaration: `function(){const elements=[],skip=new Set(['script','style','noscript','template','link','meta','base','head','title','path','defs']);const walk=(element,depth)=>{if(!element||depth>${options.depth ?? 24}||elements.length>=2000||skip.has(element.localName))return;elements.push(element);for(const child of element.children)walk(child,depth+1);if(element.shadowRoot)for(const child of element.shadowRoot.children)walk(child,depth+1)};walk(this,0);return elements}`, returnByValue: false })
          const arrayId = result.result?.objectId
          if (!arrayId) continue
          objects.add(arrayId)
          const properties = await send('Runtime.getProperties', { objectId: arrayId, ownProperties: true })
          for (const property of properties.result ?? []) {
            if (!/^\d+$/u.test(property.name) || !property.value?.objectId) continue
            const objectId = property.value.objectId
            objects.add(objectId)
            const dataResult = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: `function(){
              const attrs=Object.fromEntries([...this.attributes].map(a=>[a.name,a.value])),tag=this.localName,type=(attrs.type||'').toLowerCase(),style=getComputedStyle(this),rect=this.getBoundingClientRect();
              let own='';for(const child of this.childNodes)if(child.nodeType===3)own+=child.textContent;own=String(own||'').replace(/\\s+/g,' ').trim().slice(0,60);
              const clickable=(tag==='a'&&this.hasAttribute('href'))||['button','select','summary','label'].includes(tag)||(tag==='input'&&type!=='hidden')||this.hasAttribute('onclick')||style.cursor==='pointer';
              const editable=tag==='textarea'||this.isContentEditable||(tag==='input'&&!['button','submit','reset','checkbox','radio','hidden','file','range','color','image'].includes(type));
              const hidden=rect.width<=0||rect.height<=0||style.visibility==='hidden'||style.display==='none',off=!hidden&&(rect.bottom<0||rect.top>innerHeight||rect.right<0||rect.left>innerWidth);
              let depth=0,parent=this;while(parent.parentElement&&parent.parentElement!==document.body){depth++;parent=parent.parentElement}
              return {tag,attrs,own,clickable,editable,hidden,off,depth};
            }`, returnByValue: true })
            if (dataResult.exceptionDetails) throw new Error(`DOM tree observation failed: ${dataResult.exceptionDetails.text}`)
            const data = dataResult.result?.value
            if (!data) continue
            if (options.interactive && !data.clickable && !data.editable) continue
            const description = await send('DOM.describeNode', { objectId }), nativeId = description.node?.backendNodeId
            if (!(typeof nativeId === 'number' && nativeId > 0)) continue
            const depth = options.interactive ? 0 : data.depth, attrs = data.attrs
            const marks = `${data.hidden ? ' (hidden)' : data.off ? ' (offscreen)' : ''}${attrs.disabled !== undefined || attrs['aria-disabled'] === 'true' ? ' [disabled]' : ''}${data.editable ? ' [edit]' : ''}${data.clickable ? ' [click]' : ''}${data.tag === 'input' && attrs.type ? ` [type=${attrs.type}]` : ''}${data.tag === 'a' && attrs.href ? ` href=${JSON.stringify(attrs.href.slice(0, 80))}` : ''}${attrs.target === '_blank' ? ' [newtab]' : ''}`
            rows.push({ frame, backendNodeId: nativeId, role: attrs.role || data.tag, name: data.own, interactive: data.clickable || data.editable, depth, line: `${'  '.repeat(depth)}<${data.tag}${attrs.id ? `#${attrs.id.slice(0, 40)}` : ''}${String(attrs.class ?? '').split(/\s+/u).filter(Boolean).slice(0, 2).map((name) => `.${name.slice(0, 30)}`).join('')}>${data.own ? ` ${JSON.stringify(data.own)}` : ''} [dom=${nativeId}]${marks}` })
          }
        } finally {
          for (const objectId of objects) {
            try { await send('Runtime.releaseObject', { objectId }) }
            catch (error) { checkSnapshotFailure(transport, error) }
          }
        }
      }
    })
  }
  return rows
}

async function domRows(transport: NativeTransport, scope: NativeScope, options: NativeSnapshotOptions): Promise<NativeRow[]> {
  const rows: NativeRow[] = [], selected = await scopedFrames(transport, scope)
  const skip = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'base', 'head', 'title', 'path', 'defs'])
  for (const sessionId of new Set(scope.frames.map((frame) => frame.sessionId))) {
    let capture: any
    try {
      capture = await transport.send<any>('DOMSnapshot.captureSnapshot', { computedStyles: ['display', 'visibility', 'cursor'], includeDOMRects: true, includePaintOrder: true, includeUserAgentShadowTree: true }, sessionId)
    } catch (error) { checkSnapshotFailure(transport, error) }
    const frames = scope.frames.filter((frame) => frame.sessionId === sessionId)
    if (!capture?.documents?.length || !capture.strings) {
      rows.push(...await liveDomRows(transport, scope, options, frames, selected)); continue
    }
    const strings: string[] = capture.strings
    for (const document of capture.documents) {
      const frame = frames.find((item) => item.id === (typeof document.frameId === 'number' ? strings[document.frameId] : document.frameId))
      if (!frame) continue
      const allowed = selected.get(frame.id)
      if (allowed?.size === 0) continue
      const nodes = document.nodes, layout = document.layout
      if (!nodes?.nodeType) continue
      const children = new Map<number, number[]>(), attributes = new Map<number, Record<string, string>>()
      for (let index = 0; index < nodes.nodeType.length; index++) {
        const siblings = children.get(nodes.parentIndex[index]) ?? []
        siblings.push(index); children.set(nodes.parentIndex[index], siblings)
        const values: number[] = nodes.attributes[index] ?? [], attrs: Record<string, string> = {}
        for (let offset = 0; offset + 1 < values.length; offset += 2) attrs[strings[values[offset]]] = strings[values[offset + 1]]
        attributes.set(index, attrs)
      }
      const positions = new Map<number, number>((layout?.nodeIndex ?? []).map((node: number, index: number) => [node, index]))
      const ownText = (index: number) => clean((children.get(index) ?? []).filter((child) => nodes.nodeType[child] === 3).map((child) => strings[nodes.nodeValue[child]] ?? '').join(''), 60)
      const roots = allowed ? [...(scope.roots?.get(frame.id) ?? [])].map((id) => nodes.backendNodeId.indexOf(id)).filter((index) => index >= 0) : [nodes.nodeName.findIndex((name: number) => strings[name]?.toLowerCase() === 'body')]
      const viewport = await transport.evaluate<{ width: number; height: number }>('({width:innerWidth,height:innerHeight})', frame)
      const visited = new Set<number>()
      const visit = (index: number, depth: number) => {
        if (index < 0 || visited.has(index) || depth > (options.depth ?? 24)) return
        visited.add(index)
        const tag = strings[nodes.nodeName[index]]?.toLowerCase()
        if (nodes.nodeType[index] !== 1 || !tag || skip.has(tag)) return
        const attrs = attributes.get(index)!, type = (attrs.type ?? '').toLowerCase(), position = positions.get(index)
        const bounds = position === undefined ? undefined : layout.bounds?.[position], style = position === undefined ? [] : (layout.styles?.[position] ?? []).map((value: number) => strings[value])
        const hidden = !bounds || bounds[2] <= 0 || bounds[3] <= 0 || style[0] === 'none' || style[1] === 'hidden'
        const offscreen = !hidden && (bounds[0] + bounds[2] < (document.scrollOffsetX ?? 0) || bounds[1] + bounds[3] < (document.scrollOffsetY ?? 0) || bounds[0] > (document.scrollOffsetX ?? 0) + viewport.width || bounds[1] > (document.scrollOffsetY ?? 0) + viewport.height)
        const clickable = tag === 'a' && attrs.href !== undefined || ['button', 'select', 'summary', 'label'].includes(tag) || tag === 'input' && type !== 'hidden' || style[2] === 'pointer' || attrs.role === 'button'
        const editable = tag === 'textarea' || tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'hidden', 'file', 'range', 'color', 'image'].includes(type) || attrs.contenteditable !== undefined && attrs.contenteditable !== 'false'
        const name = ownText(index), backendNodeId = nodes.backendNodeId[index], rowDepth = options.interactive ? 0 : depth
        if ((!options.interactive || clickable || editable) && (!allowed || allowed.has(backendNodeId))) {
          const marks = ` [dom=${backendNodeId}]${hidden ? ' (hidden)' : offscreen ? ' (offscreen)' : ''}${attrs.disabled !== undefined || attrs['aria-disabled'] === 'true' ? ' [disabled]' : ''}${editable ? ' [edit]' : ''}${clickable ? ' [click]' : ''}${tag === 'input' && type ? ` [type=${type}]` : ''}${tag === 'a' && attrs.href ? ` href=${JSON.stringify(attrs.href.slice(0, 80))}` : ''}${attrs.target === '_blank' ? ' [newtab]' : ''}`
          rows.push({ frame, backendNodeId, role: attrs.role || tag, name, interactive: clickable || editable, depth: rowDepth, line: `${'  '.repeat(rowDepth)}<${tag}${attrs.id ? `#${attrs.id.slice(0, 40)}` : ''}${(attrs.class ?? '').split(/\s+/u).filter(Boolean).slice(0, 2).map((name) => `.${name.slice(0, 30)}`).join('')}>${name ? ` ${JSON.stringify(name)}` : ''}${marks}` })
        }
        for (const child of children.get(index) ?? []) visit(child, depth + 1)
      }
      for (const root of roots) visit(root, 0)
    }
  }
  return rows
}

type RawTreeRequest = Extract<BrowserUtilityRequest, { kind: 'a11yTree' | 'domTree' }>
type DomTreeRequest = Extract<RawTreeRequest, { kind: 'domTree' }>
type RawTreeRow = Pick<NativeRow, 'line' | 'frame' | 'backendNodeId'>
type RawTreeRows = { groups: RawTreeRow[][]; scopeNotFound?: boolean; fallback?: boolean; capped?: boolean }
type RawDomNode = {
  frame: NativeFrame
  backendNodeId?: number
  type: number
  tag: string
  attrs: Record<string, string>
  text: string
  styles: string[]
  bounds?: number[]
  parent?: RawDomNode
  children: RawDomNode[]
  clickable?: boolean
  editable?: boolean
}
type RawDomCapture = {
  strings: string[]
  documents: {
    frameId: string | number
    nodes: { nodeType: number[]; parentIndex: number[]; nodeName: number[]; nodeValue: number[]; backendNodeId: number[]; attributes: number[][]; contentDocumentIndex?: { index: number[]; value: number[] } }
    layout: { nodeIndex: number[]; bounds: number[][]; styles: number[][] }
  }[]
}

function rawAccessibilityGroups(groups: { frame: NativeFrame; nodes: AxNode[] }[], frames: NativeFrame[], request: RawTreeRequest): RawTreeRow[][] {
  const rows: RawTreeRow[][] = [], keyword = request.text?.toLowerCase()
  for (const { frame, nodes } of groups) {
    const byId = new Map(nodes.map((node) => [node.nodeId, node])), children = new Set(nodes.flatMap((node) => node.childIds ?? []))
    const grouped = new Map<RawTreeRow, RawTreeRow[]>(), owners = new Map(frames.filter((candidate) => candidate.sessionId === frame.sessionId).map((candidate) => [candidate.id, candidate]))
    const visit = (node: AxNode & { frameId?: string }, depth: number, inherited: NativeFrame, parent?: RawTreeRow) => {
      const owner = node.frameId ? owners.get(node.frameId) ?? inherited : inherited
      let row: RawTreeRow | undefined
      const role = node.role?.value || 'unknown', name = clean(node.name?.value, 80), value = typeof node.value?.value === 'string' ? clean(node.value.value, 40) : ''
      if (!node.ignored && role !== 'InlineTextBox' && role !== 'none' && (name || value || node.backendDOMNodeId)) {
        const marks: string[] = []
        for (const property of node.properties ?? []) {
          const value = property.value?.value, key = property.name
          if (['disabled', 'hidden', 'invisible', 'offscreen', 'focusable', 'focused', 'editable', 'readonly', 'required', 'modal', 'busy', 'selected'].includes(key) && value === true) marks.push(key)
          else if (['checked', 'pressed'].includes(key) && (value === true || value === 'mixed')) marks.push(value === true ? key : `${key}=mixed`)
          else if (key === 'expanded' && typeof value === 'boolean') marks.push(value ? 'expanded' : 'collapsed')
          else if ((key === 'hasPopup' || key === 'popup') && !marks.some((mark) => mark.startsWith('hasPopup'))) {
            if (value === true) marks.push('hasPopup')
            else if (typeof value === 'string' && value && value !== 'false' && value !== 'none') marks.push(`hasPopup=${value}`)
          } else if ((key === 'current' || key === 'invalid') && typeof value === 'string' && value && value !== 'false') marks.push(value === 'true' ? key : `${key}=${value}`)
          else if (key === 'errorMessage' && typeof value === 'string' && value.trim()) marks.push(`error="${clean(value, 40)}"`)
          else if (key === 'placeholder' && typeof value === 'string' && value.trim()) marks.push(`placeholder="${clean(value, 30)}"`)
          else if (['level', 'valueNow', 'valueMin', 'valueMax', 'positionInSet', 'setSize'].includes(key) && typeof value === 'number') marks.push(`${key === 'positionInSet' ? 'pos' : key}=${value}`)
          else if (key === 'orientation' && typeof value === 'string' && value) marks.push(`orientation=${value}`)
        }
        const backendNodeId = typeof node.backendDOMNodeId === 'number' && node.backendDOMNodeId > 0 ? node.backendDOMNodeId : undefined
        row = { frame: owner, backendNodeId, line: `${'  '.repeat(depth)}- ${role}${name ? ` "${name}"` : ''}${value ? ` value="${value}"` : ''}${backendNodeId ? ` [dom=${backendNodeId}]` : ''}${marks.length ? ` [${marks.join(' ')}]` : ''}` }
        if (!keyword || row.line.toLowerCase().includes(keyword)) {
          if (keyword && parent) {
            let group = grouped.get(parent)
            if (!group) { group = [parent]; grouped.set(parent, group); rows.push(group) }
            group.push(row)
          } else rows.push([row])
        }
      }
      for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) visit(child, depth + 1, owner, row?.backendNodeId ? row : parent) }
    }
    for (const node of nodes) if (!children.has(node.nodeId)) visit(node, 0, frame)
  }
  return rows
}

async function rawSelector(transport: NativeTransport, frame: NativeFrame, selector: string): Promise<{ backendNodeId: number; frameId?: string } | undefined> {
  const objectId = await transport.evaluate<string | undefined>(`document.querySelector(${JSON.stringify(selector)})`, frame, false)
  if (!objectId) return
  try {
    const { node } = await transport.send<{ node: { backendNodeId: number; frameId?: string; contentDocument?: { frameId?: string } } }>('DOM.describeNode', { objectId }, frame.sessionId)
    return { backendNodeId: node.backendNodeId, frameId: node.contentDocument?.frameId ?? node.frameId }
  } finally { await transport.send('Runtime.releaseObject', { objectId }, frame.sessionId) }
}

function rawDomGroups(roots: RawDomNode[], request: DomTreeRequest, viewport?: { width: number; height: number }): RawTreeRow[][] {
  const groups: RawTreeRow[][] = [], keyword = request.text?.toLowerCase(), grouped = new Map<RawDomNode, RawTreeRow[]>()
  const skip = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'base', 'head', 'title', 'path', 'defs'])
  const nonText = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'hidden', 'file', 'range', 'color', 'image'])
  const text = (node: RawDomNode, deep: boolean): string => {
    let value = ''
    const visit = (node: RawDomNode) => {
      for (const child of node.children) {
        if (deep && value.length >= 500) break
        if (child.type === 3) value += child.text
        else if (deep && child.type === 1) visit(child)
      }
    }
    visit(node); return clean(value, deep ? 500 : 60)
  }
  const visit = (node: RawDomNode, depth: number, parent?: { node: RawDomNode; row: RawTreeRow }) => {
    const { frame, backendNodeId, tag, attrs, styles, bounds } = node
    if (node.type !== 1 || !backendNodeId || !tag || skip.has(tag) || (!keyword && depth > (request.depth ?? 24))) return
    const type = (attrs.type ?? '').toLowerCase(), own = text(node, false)
    const hidden = !bounds || bounds[2] <= 0 || bounds[3] <= 0 || styles[0] === 'none' || styles[1] === 'hidden'
    const offscreen = !hidden && !!viewport && (bounds![0] + bounds![2] < 0 || bounds![1] + bounds![3] < 0 || bounds![0] > viewport.width || bounds![1] > viewport.height)
    const clickable = node.clickable ?? (tag === 'a' && attrs.href !== undefined || ['button', 'select', 'summary', 'label'].includes(tag) || tag === 'input' && type !== 'hidden' || styles[2] === 'pointer' || attrs.role === 'button')
    const editable = node.editable ?? (tag === 'textarea' || tag === 'input' && !nonText.has(type) || attrs.contenteditable !== undefined && attrs.contenteditable !== 'false')
    const marks = ` [dom=${backendNodeId}]${hidden ? ' (hidden)' : offscreen ? ' (offscreen)' : ''}${attrs.disabled !== undefined || attrs['aria-disabled'] === 'true' ? ' [disabled]' : ''}${editable ? ' [edit]' : ''}${clickable ? ' [click]' : ''}${tag === 'input' && type ? ` [type=${type}]` : ''}${tag === 'a' && attrs.href ? ` href="${attrs.href.slice(0, 80)}"` : ''}${attrs.target === '_blank' ? ' [newtab]' : ''}`
    const row: RawTreeRow = { frame, backendNodeId, line: `${'  '.repeat(depth)}<${tag}${attrs.id ? `#${attrs.id.slice(0, 40)}` : ''}${(attrs.class ?? '').split(/\s+/u).filter(Boolean).slice(0, 2).map((name) => `.${name.slice(0, 30)}`).join('')}>${own ? ` "${own}"` : ''}${marks}` }
    const matches = !keyword || [own, attrs['aria-label'], attrs.title, attrs.placeholder, attrs.value, attrs.alt, request.deepText ? text(node, true) : '', request.includeHrefInFilter ? attrs.href : ''].some((value) => value?.toLowerCase().includes(keyword))
    if (matches) {
      if (keyword && parent) {
        let group = grouped.get(parent.node)
        if (!group) { group = [parent.row]; grouped.set(parent.node, group); groups.push(group) }
        group.push(row)
      } else groups.push([row])
    }
    for (const child of node.children) visit(child, depth + 1, clickable || editable ? { node, row } : parent)
  }
  for (const root of roots) visit(root, 0)
  return groups
}

async function liveDomTree(transport: NativeTransport, frame: NativeFrame, request: DomTreeRequest): Promise<RawTreeRows> {
  return transport.withFrameSession(frame.id, async ({ send, contextId }) => {
    const objects = new Set<string>()
    try {
      const response = await send('Runtime.evaluate', { expression: `(() => {
        const root=${request.scope ? `document.querySelector(${JSON.stringify(request.scope)})` : 'document.body'},elements=[],parents=[];
        const skip=new Set(['script','style','noscript','template','link','meta','path','defs']);let capped=false;
        const walk=(element,depth,parent)=>{if(capped)return;if(elements.length>=${(request.max ?? 2000) * 4}){capped=true;return}if(depth>${request.text ? 'Infinity' : request.depth ?? 24}||skip.has(element.localName))return;const index=elements.length;elements.push(element);parents.push(parent);for(const child of element.children)walk(child,depth+1,index);if(element.shadowRoot)for(const child of element.shadowRoot.children)walk(child,depth+1,index)};
        if(root)walk(root,0,-1);elements.parents=parents.join(',');elements.capped=capped;elements.scopeNotFound=!root;return elements;
      })()`, ...(contextId === undefined ? {} : { contextId }), returnByValue: false })
      if (response.exceptionDetails) throw new Error(`DOM tree observation failed: ${response.exceptionDetails.text}`)
      const arrayId = response.result?.objectId
      if (!arrayId) return { groups: [], fallback: true }
      objects.add(arrayId)
      const properties = await send('Runtime.getProperties', { objectId: arrayId, ownProperties: true })
      const metadata = new Map<string, unknown>((properties.result ?? []).map((property: { name: string; value?: { value?: unknown } }) => [property.name, property.value?.value]))
      const parents = String(metadata.get('parents') ?? '').split(',').map(Number), elements = new Map<number, RawDomNode>()
      const viewport = await transport.evaluate<{ width: number; height: number }>('({width:innerWidth,height:innerHeight})', frame)
      for (const property of properties.result ?? []) {
        if (!/^\d+$/u.test(property.name) || !property.value?.objectId) continue
        const objectId = property.value.objectId
        objects.add(objectId)
        const result = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: `function(){
          const attrs=Object.fromEntries([...this.attributes].map(a=>[a.name,a.value])),tag=this.localName,type=(attrs.type||'').toLowerCase(),style=getComputedStyle(this),rect=this.getBoundingClientRect();
          let own='';for(const child of this.childNodes)if(child.nodeType===3)own+=child.textContent;
          const clickable=(tag==='a'&&this.hasAttribute('href'))||['button','select','summary','label'].includes(tag)||(tag==='input'&&type!=='hidden')||this.hasAttribute('onclick')||style.cursor==='pointer';
          const editable=tag==='textarea'||this.isContentEditable||(tag==='input'&&!['button','submit','reset','checkbox','radio','hidden','file','range','color','image'].includes(type));
          return {tag,attrs,own,clickable,editable,styles:[style.display,style.visibility,style.cursor],bounds:[rect.left,rect.top,rect.width,rect.height]};
        }`, returnByValue: true })
        if (result.exceptionDetails) throw new Error(`DOM tree observation failed: ${result.exceptionDetails.text}`)
        const data = result.result?.value
        if (!data) continue
        const { node } = await send('DOM.describeNode', { objectId }), backendNodeId = node?.backendNodeId
        if (!(typeof backendNodeId === 'number' && backendNodeId > 0)) continue
        const element: RawDomNode = { frame, backendNodeId, type: 1, tag: data.tag, attrs: data.attrs, text: '', styles: data.styles, bounds: data.bounds, clickable: data.clickable, editable: data.editable, children: [] }
        if (data.own) element.children.push({ frame, type: 3, tag: '', attrs: {}, text: data.own, styles: [], children: [] })
        elements.set(Number(property.name), element)
      }
      const roots: RawDomNode[] = []
      for (const [index, element] of elements) {
        element.parent = elements.get(parents[index])
        if (element.parent) element.parent.children.push(element); else roots.push(element)
      }
      return { groups: rawDomGroups(roots, request, viewport), fallback: true, capped: metadata.get('capped') === true, scopeNotFound: metadata.get('scopeNotFound') === true }
    } finally {
      for (const objectId of objects) {
        try { await send('Runtime.releaseObject', { objectId }) }
        catch (error) { checkSnapshotFailure(transport, error) }
      }
    }
  })
}

async function domTreeGroups(transport: NativeTransport, frames: NativeFrame[], request: DomTreeRequest, failures: string[]): Promise<RawTreeRows> {
  const nodes: RawDomNode[] = [], byBackend = new Map<string, RawDomNode>(), parents = new Map<RawDomNode, number>()
  const frameNodes = new Map<NativeFrame, RawDomNode[]>(), hosts = new Map<string, { frame: NativeFrame; backendNodeId: number }>(), missing = new Set<string | undefined>()
  const key = (sessionId: string | undefined, backendNodeId: number) => `${sessionId ?? ''}:${backendNodeId}`
  for (const sessionId of new Set(frames.map((frame) => frame.sessionId))) {
    let capture: RawDomCapture | undefined
    try { capture = await transport.send<RawDomCapture>('DOMSnapshot.captureSnapshot', { computedStyles: ['display', 'visibility', 'cursor'], includeDOMRects: true, includePaintOrder: true, includeUserAgentShadowTree: true }, sessionId) }
    catch (error) { checkSnapshotFailure(transport, error); failures.push(error instanceof Error ? error.message : String(error)) }
    if (!capture?.documents?.some((document) => document.nodes?.nodeType?.length) || !capture.strings) { missing.add(sessionId); continue }
    const { strings, documents } = capture
    for (const document of documents) {
      const frameId = typeof document.frameId === 'number' ? strings[document.frameId] : document.frameId
      const frame = frames.find((candidate) => candidate.id === frameId && candidate.sessionId === sessionId)
      if (!frame) continue
      const raw = document.nodes, layout = document.layout, positions = new Map((layout?.nodeIndex ?? []).map((index, offset) => [index, offset]))
      const content = raw.contentDocumentIndex
      content?.index.forEach((index, offset) => {
        const child = documents[content.value[offset]]
        if (child) hosts.set(typeof child.frameId === 'number' ? strings[child.frameId] : child.frameId, { frame, backendNodeId: raw.backendNodeId[index] })
      })
      const entries: RawDomNode[] = []
      for (let index = 0; index < raw.nodeType.length; index++) {
        const type = raw.nodeType[index], backendNodeId = raw.backendNodeId[index]
        if (![1, 3].includes(type) || typeof backendNodeId !== 'number') continue
        const attrs: Record<string, string> = {}, values = raw.attributes[index] ?? []
        for (let offset = 0; offset + 1 < values.length; offset += 2) attrs[strings[values[offset]]] = strings[values[offset + 1]]
        const position = positions.get(index)
        const node: RawDomNode = { frame, backendNodeId, type, tag: type === 1 ? (strings[raw.nodeName[index]] ?? '').toLowerCase() : '', attrs, text: type === 3 ? strings[raw.nodeValue[index]] ?? '' : '', styles: position === undefined ? [] : (layout.styles[position] ?? []).map((value) => strings[value]), bounds: position === undefined ? undefined : layout.bounds[position], children: [] }
        nodes.push(node); entries.push(node); byBackend.set(key(sessionId, backendNodeId), node)
        let parentIndex = raw.parentIndex[index]
        while (parentIndex >= 0 && raw.nodeType[parentIndex] === 11) parentIndex = raw.parentIndex[parentIndex]
        if (parentIndex >= 0 && ![9, 10].includes(raw.nodeType[parentIndex])) parents.set(node, raw.backendNodeId[parentIndex])
      }
      frameNodes.set(frame, entries)
    }
  }
  for (const frame of frameNodes.keys()) {
    const parent = frames.find((candidate) => candidate.id === frame.parentId)
    if (!parent || hosts.has(frame.id)) continue
    const owner = await transport.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame.id }, parent.sessionId)
    hosts.set(frame.id, { frame: parent, backendNodeId: owner.backendNodeId })
  }
  for (const node of nodes) {
    const parent = parents.get(node), host = hosts.get(node.frame.id)
    node.parent = parent === undefined ? host && byBackend.get(key(host.frame.sessionId, host.backendNodeId)) : byBackend.get(key(node.frame.sessionId, parent))
    node.parent?.children.push(node)
  }
  const normalized = new Set<string>()
  const normalize = async (frame: NativeFrame): Promise<void> => {
    if (normalized.has(frame.id)) return
    normalized.add(frame.id)
    const host = hosts.get(frame.id)
    if (!host) return
    await normalize(host.frame)
    const owner = byBackend.get(key(host.frame.sessionId, host.backendNodeId))
    if (!owner) return
    const scroll = await transport.evaluate<{ x: number; y: number }>('({x:scrollX,y:scrollY})', frame)
    const x = (owner.bounds?.[0] ?? 0) - scroll.x, y = (owner.bounds?.[1] ?? 0) - scroll.y
    if (x || y) for (const node of frameNodes.get(frame) ?? []) if (node.bounds) node.bounds = [node.bounds[0] + x, node.bounds[1] + y, node.bounds[2], node.bounds[3]]
  }
  for (const frame of frameNodes.keys()) await normalize(frame)
  let scope = request.scope, scopedFrames = frames
  try {
    while (scope?.includes('>>>')) {
      const split = scope.indexOf('>>>'), selector = scope.slice(0, split).trim()
      let child: NativeFrame | undefined
      for (const frame of scopedFrames) {
        const match = await rawSelector(transport, frame, selector)
        if (!match) continue
        child = frames.find((candidate) => candidate.id === match.frameId)
        if (child) break
      }
      if (!child) return { groups: [], scopeNotFound: true }
      scopedFrames = [child]; scope = scope.slice(split + 3).trim()
    }
  } catch (error) { checkSnapshotFailure(transport, error); return { groups: [], scopeNotFound: true } }
  const rootFrame = scopedFrames.find((frame) => !frame.parentId) ?? scopedFrames[0]
  if (!nodes.length || rootFrame && missing.has(rootFrame.sessionId)) return rootFrame ? liveDomTree(transport, rootFrame, { ...request, scope }) : { groups: [], fallback: true }
  let roots = nodes.filter((node) => node.type === 1 && node.tag === 'body' && node.frame.id === rootFrame?.id).slice(0, 1)
  if (!roots.length) roots = nodes.filter((node) => node.type === 1 && !node.parent)
  if (scope) {
    roots = []
    for (const frame of scopedFrames) {
      try {
        const match = await rawSelector(transport, frame, scope)
        const node = match && byBackend.get(key(frame.sessionId, match.backendNodeId))
        if (node) { roots = [node]; break }
      } catch (error) { checkSnapshotFailure(transport, error) }
    }
    if (!roots.length) return { groups: [], scopeNotFound: true }
  }
  let viewport: { width: number; height: number } | undefined
  try {
    const metrics = await transport.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number }; cssLayoutViewport?: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics')
    const current = metrics.cssVisualViewport ?? metrics.cssLayoutViewport
    if (current && current.clientWidth > 0 && current.clientHeight > 0) viewport = { width: current.clientWidth, height: current.clientHeight }
  } catch (error) { checkSnapshotFailure(transport, error) }
  return { groups: rawDomGroups(roots, request, viewport) }
}

export async function readRawTree(request: Extract<BrowserUtilityRequest, { kind: 'a11yTree' | 'domTree' }>, transport: NativeTransport): Promise<Record<string, unknown>> {
  const maximum = request.max && request.max > 0 ? Math.floor(request.max) : request.kind === 'a11yTree' ? 4000 : 2000
  request = request.kind === 'domTree' ? { ...request, max: maximum, depth: request.depth && request.depth > 0 ? Math.floor(request.depth) : 24 } : { ...request, max: maximum }
  const frames = await transport.frames(), failures: string[] = []
  const raw: RawTreeRows = request.kind === 'a11yTree' ? { groups: rawAccessibilityGroups(await readAccessibility(transport, frames), frames, request) } : await domTreeGroups(transport, frames, request, failures)
  const groups = raw.groups, count = groups.reduce((sum, group) => sum + group.length, 0)
  let rows = groups.flat(), headCount = rows.length, tailCount = 0
  if (count > maximum) {
    const head = Math.floor(maximum / 2), tail = maximum - head, first: RawTreeRow[] = [], last: RawTreeRow[] = []
    let start = 0, end = groups.length - 1
    while (start < groups.length && first.length + groups[start].length <= head) first.push(...groups[start++])
    while (end >= start && last.length + groups[end].length <= tail) last.unshift(...groups[end--])
    rows = [...first, ...last]; headCount = first.length; tailCount = last.length
  }
  const lines = rows.map((row) => `${row.line}${row.backendNodeId ? ` [frameId=${row.frame.id}]` : ''}`)
  if (count > maximum) lines.push(`(truncated: ${count}${raw.fallback ? '' : ' matched'} lines, showing first ${headCount} + last ${tailCount}; pass a larger max to widen)`)
  if (raw.scopeNotFound) lines.push(`dom: scope not found: ${request.kind === 'domTree' ? request.scope ?? null : null}`)
  transport.assertCurrent()
  return { tree: lines.join('\n'), count: rows.length + (raw.fallback && count > maximum ? 1 : 0), truncated: count > maximum || !!raw.capped, refs: {}, actionKey: 'backendNodeId', ...(failures.length ? { degraded: true, degradedReason: failures.join('; ') } : {}) }
}

export async function captureRawRows(transport: NativeTransport, _frames: NativeFrame[], scope: NativeScope, options: NativeSnapshotOptions): Promise<{ rows: NativeRow[]; source: 'a11yTree' | 'domTree' }> {
  const failures: string[] = []
  for (const source of ['a11yTree', 'domTree'] as const) {
    try {
      const rows = source === 'a11yTree' ? await accessibilityRows(transport, scope, options) : await domRows(transport, scope, options)
      if (!rows.length || !rows.some((row) => row.backendNodeId)) { failures.push(`${source} returned no native nodes`); continue }
      const bounded = rows.length > 500 ? [...rows.slice(0, 250), ...rows.slice(-250)] : rows
      return { rows: bounded.map((row) => ({ ...row, line: `${row.line} [frameId=${row.frame.id}]` })), source }
    } catch (error) {
      checkSnapshotFailure(transport, error)
      failures.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Snapshot failed; AX500 and DOM500 recovery failed (${failures.join('; ')})`)
}
