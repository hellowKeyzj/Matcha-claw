// @ts-expect-error Playwright's physical-key layout has no declarations.
import { USKeyboardLayout } from '../../../node_modules/playwright-core/lib/server/usKeyboardLayout.js';
import type { BrowserActRequest } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import { iabError } from './error';
import type { IabAutomationPage, BackendTarget, Operation } from './automation-page';

const pointers = new WeakMap<IabAutomationPage, { x: number; y: number }>();

async function movePointer(page: IabAutomationPage, point: { x: number; y: number }, operation: Operation, modifiers = 0, humanize = page.settings.humanize): Promise<void> {
  const previous = pointers.get(page);
  const distance = previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0;
  const steps = previous && distance >= 50 ? Math.min(20, Math.max(2, Math.ceil(distance / 60))) : 1;
  for (let step = 1; step <= steps; step++) {
    const fraction = step / steps;
    const jitter = humanize && step < steps ? (Math.random() - 0.5) * 4 : 0;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: previous ? previous.x + (point.x - previous.x) * fraction - (point.y - previous.y) / (distance || 1) * jitter : point.x, y: previous ? previous.y + (point.y - previous.y) * fraction + (point.x - previous.x) / (distance || 1) * jitter : point.y, modifiers }, operation);
    if (step < steps) await page.pause(humanize ? 6 + Math.random() * 8 : 8, operation);
  }
  pointers.set(page, { x: point.x, y: point.y });
  if (steps > 1) await page.pause(60, operation);
}

async function pace(page: IabAutomationPage, operation: Operation): Promise<void> {
  const policy = page.settings.pace;
  if (policy) await page.pause(Math.max(0, page.lastActAt + policy.minIntervalMs + Math.random() * (policy.jitterMs ?? 0) - Date.now()), operation);
  page.lastActAt = Date.now();
}

const modifierBits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
type Key = { key: string; keyCode: number; code: string; text: string; location: number };
const layout = USKeyboardLayout as Record<string, { key: string; keyCode: number; shiftKey?: string; shiftKeyCode?: number; location?: number }>;

function physicalKey(value: string, shifted = false): Key {
  const normalized = value === 'ControlOrMeta' ? process.platform === 'darwin' ? 'Meta' : 'Control' : value;
  const aliases: Record<string, string> = { esc: 'Escape', escape: 'Escape', ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', option: 'Alt', alt: 'Alt', shift: 'Shift', enter: 'Enter', return: 'Enter', del: 'Delete', delete: 'Delete', tab: 'Tab', backspace: 'Backspace', space: 'Space', ' ': 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
  const name = aliases[normalized.toLowerCase()] ?? normalized;
  const entry = layout[name] ? [name, layout[name]] as const : Object.entries(layout).find(([, key]) => key.key === name || key.shiftKey === name);
  if (!entry) return { key: name, keyCode: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0, code: '', text: name.length === 1 ? name : '', location: 0 };
  const [code, definition] = entry;
  const key = shifted && definition.shiftKey ? definition.shiftKey : name.length === 1 ? name : definition.key;
  const keyCode = shifted && definition.shiftKeyCode ? definition.shiftKeyCode : definition.keyCode;
  return { key, keyCode, code, text: key === 'Enter' ? '\r' : key.length === 1 ? key : '', location: definition.location ?? 0 };
}

export async function pressKey(page: IabAutomationPage, chord: string, operation: Operation, delayMs = 0): Promise<void> {
  const names = chord === '+' ? ['Shift', 'Equal'] : chord.split('+').map((name) => name.trim()).filter(Boolean);
  const mainName = names.pop();
  if (!mainName) throw iabError('IAB_KEY_REQUIRED', 'A keyboard key is required');
  const modifiers = names.map((name) => {
    const modifier = physicalKey(name);
    if (!modifierBits[modifier.key]) throw iabError('IAB_KEY_INVALID', `Not a keyboard modifier: ${modifier.key}`);
    return modifier;
  });
  const key = physicalKey(mainName, modifiers.some((modifier) => modifier.key === 'Shift'));
  let bits = 0;
  for (const modifier of modifiers) {
    bits |= modifierBits[modifier.key];
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: bits }, operation);
  }
  const text = bits & 7 ? '' : key.text;
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, text, unmodifiedText: key.text, modifiers: bits, location: key.location, isKeypad: key.location === 3 }, operation);
  if (delayMs) await page.pause(delayMs, operation);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: bits }, operation);
  for (const modifier of modifiers.reverse()) {
    bits &= ~modifierBits[modifier.key];
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: bits }, operation);
  }
}

async function validatePoint(page: IabAutomationPage, point: { x: number; y: number }, operation: Operation): Promise<{ width: number; height: number }> {
  const viewport = await page.evaluate('({width:innerWidth,height:innerHeight})', operation);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) throw iabError('IAB_COORDINATES_INVALID', 'Coordinates must lie inside the viewport');
  return viewport;
}

async function coordinatePoint(page: IabAutomationPage, point: { x: number; y: number }, operation: Operation): Promise<{ x: number; y: number }> {
  const viewport = await validatePoint(page, point, operation);
  return { x: Math.min(viewport.width, Math.max(0, point.x + (Math.random() - 0.5) * 6)), y: Math.min(viewport.height, Math.max(0, point.y + (Math.random() - 0.5) * 6)) };
}

function planWheel(distance: number, headroom: number | undefined): { delta: number; gap: number }[] {
  distance = Math.round(Math.abs(distance));
  if (!distance) return [];
  let rollback = Math.random() < 0.15 ? Math.min(Math.round(16 + Math.random() * 32), Math.round(distance * 0.2)) : 0;
  if (headroom !== undefined && Number.isFinite(headroom) && distance + rollback > headroom) rollback = 0;
  const forward = distance + rollback, segment = 200 + Math.random() * 160;
  const count = Math.max(1, Math.min(6, Math.max(Math.ceil(forward / segment), Math.ceil(1 + (forward * 1.1 / 360 - 0.45) / 0.9))));
  const weights = Array.from({ length: count }, (_, index) => count > 1 && index === count - 1 ? 0.45 : 0.9 + Math.random() * 0.2);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let emitted = 0, accumulated = 0;
  const segments = weights.map((weight, index) => {
    accumulated += weight;
    const target = index === count - 1 ? forward : Math.round(forward * accumulated / total);
    const delta = Math.max(1, target - emitted);
    emitted += delta;
    return { delta, gap: Math.round(40 + Math.random() * 80) };
  });
  segments[count - 1].delta += forward - emitted;
  if (count > 1) segments[count - 1].gap = Math.round(Math.max(segments[count - 1].gap, segments[count - 2].gap) * 1.6);
  if (rollback) segments.push({ delta: -rollback, gap: Math.round(40 + Math.random() * 80) });
  return segments;
}

async function wheelHeadroom(page: IabAutomationPage, point: { x: number; y: number }, deltaX: number, deltaY: number, operation: Operation): Promise<number | undefined> {
  const horizontal = Math.abs(deltaX) >= Math.abs(deltaY), positive = (horizontal ? deltaX : deltaY) >= 0;
  const scroll = horizontal ? 'scrollLeft' : 'scrollTop', extent = horizontal ? 'scrollWidth' : 'scrollHeight', client = horizontal ? 'clientWidth' : 'clientHeight', axis = horizontal ? 'X' : 'Y';
  const value = Number(await page.evaluate(`(() => {const root=document.scrollingElement||document.documentElement;let node=document.elementFromPoint(${point.x},${point.y}),total=0;if(!node||!root)return null;while(node){const remaining=${positive ? `node.${extent}-node.${scroll}-node.${client}` : `node.${scroll}`};if(node===root){total+=remaining;break;}const style=getComputedStyle(node),overflow=style.overflow${axis},overscroll=style.overscrollBehavior${axis};if(['auto','scroll','overlay'].includes(overflow)&&node.${extent}>node.${client}+1){total+=remaining;if(overscroll==='contain'||overscroll==='none')break;}node=node.parentElement||node.getRootNode()?.host||null;}return Number.isFinite(total)?Math.max(0,total):null;})()`, operation));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function pointHit(page: IabAutomationPage, point: { x: number; y: number }, operation: Operation): Promise<{ tag: string; text?: string; role?: string } | null> {
  return page.evaluate(`(() => {const element=document.elementsFromPoint(${point.x},${point.y})[0];if(!element)return null;const text=String(element.innerText||element.value||element.textContent||'').replace(/\\s+/gu,' ').trim().slice(0,60),role=element.getAttribute('role');return {tag:element.tagName.toLowerCase(),...(text?{text}:{}),...(role?{role}:{})};})()`, operation);
}

export async function clickPoint(page: IabAutomationPage, point: { x: number; y: number }, operation: Operation, options: { button?: string; doubleClick?: boolean; modifiers?: string[]; delayMs?: number; humanize?: boolean } = {}): Promise<void> {
  const humanize = options.humanize ?? page.settings.humanize;
  const button = options.button ?? 'left';
  if (!['left', 'right', 'middle'].includes(button)) throw iabError('IAB_BUTTON_INVALID', 'Invalid mouse button');
  const held = (options.modifiers ?? []).map((name) => {
    const modifier = physicalKey(name);
    if (!modifierBits[modifier.key]) throw iabError('IAB_KEY_INVALID', `Not a mouse modifier: ${modifier.key}`);
    return modifier;
  });
  await validatePoint(page, point, operation);
  let modifiers = 0;
  for (const modifier of held) {
    modifiers |= modifierBits[modifier.key];
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers }, operation);
  }
  try {
    await movePointer(page, point, operation, modifiers, humanize);
    if ('element' in point && 'localPoint' in point) await page.verifyPoint(point as Awaited<ReturnType<IabAutomationPage['actionablePoint']>>, operation);
    const clickCount = options.doubleClick ? 2 : 1;
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount, modifiers }, operation);
    if (options.delayMs || humanize) await page.pause(options.delayMs ?? (30 + Math.random() * 60), operation);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount, modifiers }, operation);
  } finally {
    for (const modifier of held.reverse()) {
      modifiers &= ~modifierBits[modifier.key];
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers }, operation);
    }
  }
}

type EditableElement = Awaited<ReturnType<IabAutomationPage['resolveElement']>>;
type EditableValue = { kind: 'value' | 'text'; value: string };

function readEditableValue(page: IabAutomationPage, element: EditableElement, operation: Operation): Promise<EditableValue | null> {
  return page.callElement(element, `if(this.tagName==='INPUT'||this.tagName==='TEXTAREA')return {kind:'value',value:String(this.value||'')};if(this.isContentEditable)return {kind:'text',value:String(this.innerText||this.textContent||'')};return null;`, [], operation);
}

function setEditableValue(page: IabAutomationPage, element: EditableElement, value: string, operation: Operation, special = false): Promise<boolean> {
  return page.callElement(element, `if(args[1]&&(this.tagName!=='INPUT'||!['date','time','datetime-local','month','week','color','range'].includes(String(this.getAttribute('type')||'').toLowerCase())))return false;const proto=this.tagName==='INPUT'?HTMLInputElement.prototype:this.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:null;if(!proto)return false;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;this.focus();if(setter)setter.call(this,args[0]);else this.value=args[0];this._valueTracker?.setValue('\\0_stale_');this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));if(args[1])this.dispatchEvent(new FocusEvent('blur'));return args[1]||this.value===args[0];`, [value, special], operation);
}

export async function typeInto(page: IabAutomationPage, params: BackendTarget & { ref?: string; text?: string; slowly?: boolean; clearFirst?: boolean; submit?: boolean }, operation: Operation): Promise<void> {
  if (typeof params.text !== 'string') throw iabError('IAB_TEXT_REQUIRED', 'Text is required');
  const point = await page.actionablePoint(params.ref, undefined, operation, ['visible', 'enabled', 'stable'], params);
  let element: EditableElement | undefined;
  try {
    await clickPoint(page, point, operation, { humanize: false });
    const description = await page.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: point.element.objectId }, operation, point.element.frame.sessionId);
    const resolved = await page.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: description.node.backendNodeId, objectGroup: 'matcha-iab-action' }, operation, point.element.frame.sessionId);
    if (!resolved.object?.objectId) throw iabError('IAB_ELEMENT_NOT_FOUND', 'Editable target was detached before typing');
    element = { frame: point.element.frame, objectId: resolved.object.objectId };
    await page.send('DOM.focus', { objectId: element.objectId }, operation, element.frame.sessionId);
    if (await setEditableValue(page, element, params.text, operation, true)) return;
    if (params.clearFirst !== false) {
      const selection = await page.callElement(element, `if(this.tagName==='TEXTAREA'||this.tagName==='INPUT'&&['text','search','url','tel','password'].includes(this.type)){this.focus();const length=String(this.value||'').length;if(length)this.setSelectionRange(0,length);return {input:true,length};}return {input:false};`, [], operation);
      if (selection.input) {
        if (selection.length) await pressKey(page, 'Backspace', operation);
        if ((await readEditableValue(page, element, operation))?.value) await setEditableValue(page, element, '', operation);
      } else {
        await pressKey(page, 'ControlOrMeta+a', operation);
        await pressKey(page, 'Delete', operation);
      }
    }
    if (page.settings.humanize || params.slowly) {
      for (const character of params.text) {
        await page.send('Input.insertText', { text: character }, operation);
        await page.pause(page.settings.humanize ? 45 + Math.random() * 65 : 75, operation);
      }
    } else await page.send('Input.insertText', { text: params.text }, operation);
    await page.callElement(element, `if(this.tagName==='INPUT'||this.tagName==='TEXTAREA')this._valueTracker?.setValue('\\0_stale_');this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;`, [], operation);
    let observed = await readEditableValue(page, element, operation);
    const accepted = !observed || (params.clearFirst !== false ? observed.value === params.text : !params.text || observed.value.endsWith(params.text));
    if (!accepted && observed?.kind === 'value' && await setEditableValue(page, element, params.text, operation)) {
      observed = await readEditableValue(page, element, operation);
      if (observed && observed.value !== params.text) throw iabError('IAB_FILL_FAILED', `Typed text was not accepted by the target (expected length ${params.text.length}, observed length ${observed.value.length})`);
    } else if (!accepted) throw iabError('IAB_FILL_FAILED', `Typed text was not accepted by the target (expected length ${params.text.length}, observed length ${observed?.value.length ?? 0})`);
    if (params.submit) await pressKey(page, 'Enter', operation);
  } finally {
    for (const objectId of new Set([point.element.objectId, element?.objectId])) if (objectId) {
      try { await page.send('Runtime.releaseObject', { objectId }, operation, point.element.frame.sessionId); }
      catch (error) { operation.failures.push(error); }
    }
  }
}

export async function scrollPage(page: IabAutomationPage, direction: string | undefined, amount: number | undefined, operation: Operation): Promise<Record<string, number | boolean>> {
  return page.evaluate(`(() => {
    const dir = ${JSON.stringify(direction ?? 'down')};
    const amt = ${typeof amount === 'number' && Number.isFinite(amount) ? amount : 0};
    const step = amt > 0 ? amt : Math.round(window.innerHeight * 0.9);
    if (dir === 'top') window.scrollTo(0, 0);
    else if (dir === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
    else if (dir === 'up') window.scrollBy(0, -step);
    else if (dir === 'down') window.scrollBy(0, step);
    else if (dir === 'left') window.scrollBy(-step, 0);
    else if (dir === 'right') window.scrollBy(step, 0);
    const scrollY = window.scrollY;
    const scrollHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;
    const maxScroll = Math.max(0, scrollHeight - viewportHeight);
    return {
      scrollY, scrollHeight, viewportHeight,
      atTop: scrollY <= 0,
      atBottom: scrollY >= maxScroll - 1,
      scrollPercentage: maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 0,
    };
  })()`, operation);
}

export async function performAct(page: IabAutomationPage, request: BrowserActRequest, operation: Operation): Promise<Record<string, any>> {
  if (request.kind === 'fill') {
    if (!Array.isArray(request.fields) || !request.fields.length) throw iabError('IAB_FIELDS_REQUIRED', 'At least one form field is required');
    for (const field of request.fields) {
      if (!field || typeof field !== 'object' || (!(typeof field.ref === 'string' && field.ref.trim()) && !(Number.isSafeInteger(field.backendNodeId) && field.backendNodeId! > 0))) throw iabError('IAB_FILL_TARGET_REQUIRED', 'Each form field requires a ref or backendNodeId');
      if (!['text', 'select', 'checkbox', 'radio'].includes(field.type || 'text')) throw iabError('IAB_FILL_TYPE_INVALID', 'Form field type must be text/select/checkbox/radio');
    }
  }
  const refs = request.kind === 'fill' ? request.fields!.filter((field) => field.backendNodeId === undefined).map((field) => field.ref) : request.kind === 'drag' ? [request.startRef, request.endRef] : 'ref' in request && (!('backendNodeId' in request) || request.backendNodeId === undefined) ? [request.ref] : [];
  const updated = await page.refreshChangedRefs(refs, operation);
  if (updated) return updated;
  const observeDom = ['click', 'clickCoords', 'type', 'drag', 'dragCoords', 'hoverCoords', 'wheelCoords'].includes(request.kind ?? '');
  const before = observeDom ? await page.domSignature(operation) : undefined;
  const eventCursor = Number(page.events.at(-1)?.seq ?? 0);
  let result: Record<string, any>;
  try { result = await actInput(page, request, operation); }
  catch (error) {
    operation.signal.throwIfAborted(); operation.assertCurrent?.();
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (refs.some(Boolean) && (code === 'IAB_ELEMENT_NOT_FOUND' || code === 'IAB_DOCUMENT_CHANGED')) return page.updatedSnapshot(code === 'IAB_DOCUMENT_CHANGED' ? 'document_changed' : 'no_backend', operation);
    throw error;
  }
  if (result.ok === false || result.actionPerformed === false) return result;
  operation.onActionPerformed?.();
  try {
    const pageEvents = page.events.filter((event) => Number(event.seq) > eventCursor);
    if (pageEvents.length) {
      result.pageEvents = pageEvents;
      if (pageEvents.some((event) => event.kind === 'dialog')) result.hint = 'A JavaScript dialog opened and was auto-answered; inspect pageEvents and verify the resulting state before proceeding.';
      else if (pageEvents.some((event) => event.kind === 'rendererCrash')) result.hint = 'The renderer crashed; take a snapshot before retrying.';
    }
    if (before !== undefined && before !== await page.domSignature(operation)) {
      result.domChanged = true;
      result.hint = 'The page DOM changed after this action. Take a fresh snapshot before any further interaction.';
    }
  } catch (error) {
    operation.signal.throwIfAborted(); operation.assertCurrent?.();
    if (!(error instanceof Error) || !('code' in error) || !['IAB_TIMEOUT', 'IAB_WAIT_TIMEOUT'].includes(String(error.code))) throw error;
    return { ...result, actionPerformed: true, observationComplete: false, warning: { code: 'ACTION_OBSERVATION_TIMEOUT', message: 'The action was performed, but post-action observation timed out. Inspect the page before deciding what to do next; do not repeat the input automatically.' } };
  }
  return result;
}

async function actInput(page: IabAutomationPage, request: BrowserActRequest, operation: Operation): Promise<Record<string, any>> {
  if (!['wait', 'evaluate', undefined].includes(request.kind)) await pace(page, operation);
  switch (request.kind) {
    case 'click': {
      const point = await page.actionablePoint(request.ref, request.selector, operation, undefined, request);
      await clickPoint(page, point, operation, request);
      return { clicked: true };
    }
    case 'clickCoords': {
      if (typeof request.x !== 'number' || typeof request.y !== 'number') throw iabError('IAB_COORDINATES_REQUIRED', 'Click coordinates are required');
      const point = await coordinatePoint(page, { x: request.x, y: request.y }, operation);
      const hit = await pointHit(page, point, operation);
      await clickPoint(page, point, operation, request);
      return { clicked: true, ...point, hit };
    }
    case 'type': await typeInto(page, request, operation); return { typed: true };
    case 'press': if (!request.key) throw iabError('IAB_KEY_REQUIRED', 'A key is required'); await pressKey(page, request.key, operation, request.delayMs); return { pressed: true };
    case 'hover': {
      const point = await page.actionablePoint(request.ref, undefined, operation, ['visible', 'stable'], request);
      await movePointer(page, point, operation);
      return { hovered: true };
    }
    case 'scrollIntoView': {
      const element = await page.resolveElement(request.ref, undefined, operation, request);
      await page.send('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId }, operation, element.frame.sessionId);
      return { scrolled: true };
    }
    case 'hoverCoords': {
      const point = await coordinatePoint(page, { x: request.x!, y: request.y! }, operation);
      const hit = await pointHit(page, point, operation);
      await movePointer(page, point, operation, 0, request.humanize ?? page.settings.humanize);
      return { hovered: true, ...point, hit };
    }
    case 'wheelCoords': {
      const deltaX = request.deltaX ?? 0, deltaY = request.deltaY ?? 0;
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || !deltaX && !deltaY) throw iabError('IAB_WHEEL_DELTA_INVALID', 'Wheel requires finite, nonzero deltas');
      const point = await coordinatePoint(page, { x: request.x!, y: request.y! }, operation);
      const humanize = request.humanize ?? page.settings.humanize;
      const hit = await pointHit(page, point, operation);
      const segments = humanize ? planWheel(Math.max(Math.abs(deltaX), Math.abs(deltaY)), await wheelHeadroom(page, point, deltaX, deltaY, operation)) : undefined;
      if (segments && !segments.length) throw iabError('IAB_WHEEL_DELTA_INVALID', 'Humanized wheel rounds to zero displacement; use a delta of at least 1 CSS px or humanize:false');
      await movePointer(page, point, operation, 0, humanize);
      if (segments) {
        const net = segments.reduce((sum, segment) => sum + segment.delta, 0);
        let emittedX = 0, emittedY = 0;
        for (const [index, segment] of segments.entries()) {
          const last = index === segments.length - 1;
          const x = last ? deltaX - emittedX : Math.round(deltaX * segment.delta / net), y = last ? deltaY - emittedY : Math.round(deltaY * segment.delta / net);
          emittedX += x; emittedY += y;
          await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: x, deltaY: y }, operation);
          if (segment.gap) await page.pause(segment.gap, operation);
        }
      } else await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY }, operation);
      return { scrolled: true, ...point, deltaX, deltaY, hit };
    }
    case 'drag': case 'dragCoords': {
      const steps = request.steps ?? 10, durationMs = request.durationMs ?? 400;
      if (!Number.isInteger(steps) || steps < 1 || steps > 60 || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10_000) throw iabError('IAB_DRAG_OPTIONS_INVALID', 'Drag steps must be 1–60 and durationMs 0–10000');
      if (request.kind === 'drag' && request.endRef && (request.endX !== undefined || request.endY !== undefined)) throw iabError('IAB_DRAG_TARGET_AMBIGUOUS', 'Use an end ref or coordinates, not both');
      const end = request.kind === 'dragCoords' ? request.to : request.endRef ? await page.actionablePoint(request.endRef, undefined, operation) : { x: request.endX!, y: request.endY! };
      const source = request.kind === 'drag' ? await page.actionablePoint(request.startRef, undefined, operation) : undefined;
      const start = request.kind === 'dragCoords' ? request.from : source;
      if (!start || !end) throw iabError('IAB_COORDINATES_REQUIRED', 'Drag requires from/to coordinates');
      await validatePoint(page, start, operation);
      await validatePoint(page, end, operation);
      const fromHit = await pointHit(page, start, operation);
      await movePointer(page, start, operation, 0, false);
      if (source) await page.verifyPoint(source, operation);
      let x = start.x, y = start.y, pressed = false;
      try {
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, operation);
        pressed = true;
        for (let step = 1; step <= steps; step++) {
          if (durationMs) await page.pause(durationMs / steps, operation);
          x = start.x + (end.x - start.x) * step / steps;
          y = start.y + (end.y - start.y) * step / steps;
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, operation);
          pointers.set(page, { x, y });
        }
      } finally {
        if (pressed) await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, operation);
      }
      return { dragged: true, from: { x: start.x, y: start.y, hit: fromHit }, to: { x: end.x, y: end.y, hit: await pointHit(page, end, operation) }, steps, gestureDurationMs: durationMs };
    }
    case 'select': {
      if (!request.values?.length) throw iabError('IAB_VALUES_REQUIRED', 'A non-empty select values array is required');
      const point = await page.actionablePoint(request.ref, undefined, operation, undefined, request);
      const values = await page.callElement(point.element, 'return h.selectOptions(this,args[0].map(value=>({valueOrLabel:value})));', [request.values], operation);
      if (!Array.isArray(values)) throw iabError('IAB_SELECT_FAILED', String(values));
      return { values };
    }
    case 'fill': {
      const applied: Record<string, string | number>[] = [], failed: Record<string, string | number>[] = [];
      for (const [index, field] of request.fields!.entries()) {
        const item = { index, ref: field.ref ?? '', type: field.type || 'text' };
        try {
        if (field.type === 'checkbox' || field.type === 'radio') {
          const point = await page.actionablePoint(field.ref, undefined, operation, undefined, field);
          const checked = await page.callElement(point.element, 'return h.elementState(this,"checked").matches;', [], operation);
          const expected = field.value === true || field.value === 1 || field.value === '1' || field.value === 'true';
          if (checked !== expected) {
            await clickPoint(page, point, operation);
            const updated = await page.callElement(point.element, 'return h.elementState(this,"checked").matches;', [], operation);
            if (updated !== expected) throw iabError('IAB_CHECK_FAILED', 'Checkbox/radio did not reach the requested state');
          }
        } else if (field.type === 'select') await actInput(page, { kind: 'select', ref: field.ref, backendNodeId: field.backendNodeId, frameId: field.frameId, values: [String(field.value ?? '')] }, operation);
        else await typeInto(page, { ...field, text: String(field.value ?? '') }, operation);
        applied.push(item);
        } catch (error) {
          operation.signal.throwIfAborted(); operation.assertCurrent?.();
          const code = error instanceof Error && 'code' in error ? String(error.code) : '';
          if (!['IAB_REF_STALE', 'IAB_ELEMENT_NOT_FOUND', 'IAB_DOCUMENT_CHANGED', 'IAB_ELEMENT_NOT_ACTIONABLE', 'IAB_FILL_FAILED', 'IAB_CHECK_FAILED', 'IAB_SELECT_FAILED', 'IAB_ELEMENT_ACTION_FAILED'].includes(code)) throw error;
          failed.push({ ...item, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      if (failed.length) return { ok: false, error: { code: 'BROWSER_FILL_PARTIAL_FAILURE', message: `browser_fill partially applied: ${applied.length} field(s) succeeded, ${failed.length} field(s) failed.`, retryable: false }, partial: { appliedCount: applied.length, failedCount: failed.length, applied, failed } };
      return { appliedCount: applied.length };
    }
    case 'resize': {
      if (!Number.isFinite(request.width) || !Number.isFinite(request.height) || request.width! <= 0 || request.height! <= 0) throw iabError('IAB_VIEWPORT_INVALID', 'Viewport dimensions must be positive finite numbers');
      await page.send('Emulation.setDeviceMetricsOverride', { width: request.width!, height: request.height!, deviceScaleFactor: 0, mobile: false }, operation);
      return { width: request.width!, height: request.height! };
    }
    case 'wait': {
      await page.wait(request, operation);
      const condition = typeof request.timeMs === 'number' && request.timeMs > 0 ? 'time' : request.loadState ? 'loadState' : request.text ? 'text' : request.textGone ? 'textGone' : request.selector ? 'selector' : request.url ? 'url' : 'fn';
      return { satisfied: true, condition };
    }
    case 'scroll': return scrollPage(page, request.scrollDirection, request.scrollAmount, operation);
    case undefined:
    case 'evaluate': {
      if (request.ref?.trim()) throw iabError('IAB_EVALUATE_REF_UNSUPPORTED', 'Ref-scoped evaluate is not supported');
      const expression = request.fn || request.expression;
      if (!expression?.trim()) throw iabError('IAB_EXPRESSION_REQUIRED', 'An evaluation expression or function is required');
      const frameId = request.frameId?.trim();
      const result = await page.evaluateInFrame(expression, frameId || undefined, operation);
      return { ...(frameId ? { frameId } : {}), ...(result === undefined ? {} : { result }) };
    }
    case 'close': throw iabError('IAB_CLOSE_REQUIRES_MANAGER', 'Tab close must be handled by the Main tab owner');
  }
}
