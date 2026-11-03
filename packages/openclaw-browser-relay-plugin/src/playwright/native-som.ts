import type { BrowserUtilityRequest } from '../browser-action-contract.js'
import { readRelayError } from '../relay/errors.js'
import { checkSnapshotFailure, type NativeTransport } from './native-snapshot.js'

const overlayId = '__som_overlay__'
const identityKey = '__sdk_som_node_identity_v1__'
const defaultSelector = 'a, button, input, select, textarea, label, summary, [role], [onclick], [contenteditable]'
const round = (value: number) => Math.round(value * 10) / 10
const domSignature = `(function () {
  try {
    var nodes = document.getElementsByTagName('*');
    var parts = [];
    for (var i = 0; i < nodes.length && parts.length < 128; i += 64) {
      var el = nodes[i];
      parts.push(el.tagName + (el.id ? '#' + el.id : ''));
    }
    var kids = document.body ? document.body.children : [];
    var tail = '';
    for (var k = kids.length - 1; k >= 0 && kids.length - k <= 8; k--) {
      var t = kids[k].tagName;
      if (t !== 'SCRIPT' && t !== 'STYLE' && t !== 'LINK' && t !== 'NOSCRIPT' && t !== 'TEMPLATE') {
        tail = t + (kids[k].id ? '#' + kids[k].id : '');
        break;
      }
    }
    parts.push('<' + tail);
    return parts.join('|');
  } catch (e) { return ''; }
})()`
const targetSignature = `(function (el) {
  function attr(name, limit) { return String(el.getAttribute(name) || '').slice(0, limit); }
  return JSON.stringify([String(el.tagName),
    String(el.innerText || el.value || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    attr('role', 80), attr('href', 512), attr('aria-label', 128), attr('type', 64)]);
})`
const viewportSource = `(function () {
  var de = document.documentElement;
  return { width: de ? de.clientWidth : window.innerWidth, height: de ? de.clientHeight : window.innerHeight };
})()`
const cleanupSource = `(function () {
  var el = document.getElementById('${overlayId}');
  if (el && el.parentNode) el.parentNode.removeChild(el);
  return true;
})()`

export async function readSom(request: Extract<BrowserUtilityRequest, { kind: 'som' }>, transport: NativeTransport, captureScreenshot: () => Promise<string>): Promise<Record<string, unknown>> {
  transport.assertCurrent()
  const mode = request.mode ?? 'dom'
  if (mode !== 'dom' && mode !== 'vision') throw new Error('mode must be "dom" or "vision"')
  const limit = request.maxMarks === undefined ? 60 : Number(request.maxMarks)
  if (!Number.isFinite(limit)) throw new Error('maxMarks must be finite')
  const maxMarks = Math.min(200, Math.max(1, Math.floor(limit)))
  const selector = request.selector?.trim() || defaultSelector
  const frame = (await transport.frames()).find((candidate) => !candidate.parentId)
  if (!frame) throw new Error('SOM requires a current main frame')
  if (mode === 'vision') {
    const viewport = readViewport(await transport.evaluate(viewportSource, frame))
    if (!viewport) throw new Error('viewport read failed: invalid size')
    const result: Record<string, unknown> = { mode, viewport, marks: [] }
    if (request.screenshot !== false) {
      result.imageBase64 = await captureScreenshot()
      result.imageType = 'png'
    }
    transport.assertCurrent()
    return result
  }
  const collected = await transport.evaluate<Record<string, unknown> | null>(collectSource(selector), frame)
  if (!collected || typeof collected !== 'object' || collected.ok !== true) throw new Error(`mark collection failed: ${collected?.error ?? 'unexpected page result'}`)
  const viewport = readViewport(collected.viewport)
  if (!viewport) throw new Error('mark collection failed: invalid viewport size')
  const candidates = (Array.isArray(collected.raw) ? collected.raw as unknown[] : []).map(readMark).filter((mark): mark is NonNullable<typeof mark> => mark !== null)
  const marks = candidates.slice(0, maxMarks).map((mark, index) => ({ ...mark, id: index + 1 }))
  const anchor = readAnchor(collected.anchor)
  const result: Record<string, unknown> = { mode, viewport, marks, ...(anchor ? { anchor } : {}), ...(candidates.length > marks.length ? { truncated: true } : {}) }
  if (request.screenshot === false) {
    transport.assertCurrent()
    return result
  }
  const failures: unknown[] = []
  let imageBase64: string | undefined
  try {
    await transport.evaluate(overlaySource(marks), frame)
    imageBase64 = await captureScreenshot()
  } catch (error) { failures.push(error) }
  finally {
    try { await transport.evaluate(cleanupSource, frame) }
    catch (error) {
      try { checkSnapshotFailure(transport, error) }
      catch (failure) { failures.push(failure) }
      // The page overlay also removes itself after 15 seconds.
    }
  }
  transport.assertCurrent()
  if (failures.length) throw failures.find((error) => {
    const { errorDetail } = readRelayError(error)
    const code = errorDetail?.code ?? (error && typeof error === 'object' && 'code' in error ? error.code : undefined)
    return errorDetail?.outcome === 'unknown' || code === 'IAB_CDP_OUTCOME_UNKNOWN'
  }) ?? failures[0]
  return { ...result, imageBase64: imageBase64!, imageType: 'png' }
}

function collectSource(selector: string): string {
  return `(function () {
    var de = document.documentElement;
    var vw = de ? de.clientWidth : window.innerWidth;
    var vh = de ? de.clientHeight : window.innerHeight;
    var nodes;
    try { nodes = document.querySelectorAll(${JSON.stringify(selector)}); }
    catch (e) { return { ok: false, error: 'invalid selector: ' + String((e && e.message) || e) }; }
    var key = ${JSON.stringify(identityKey)};
    var store = document[key];
    if (!store) {
      store = { tokens: new WeakMap(), refs: new Map(), next: 0 };
      Object.defineProperty(document, key, { value: store, configurable: true });
    }
    var out = [];
    for (var i = 0; i < nodes.length && out.length < 400; i++) {
      var el = nodes[i];
      var tag = el.tagName;
      if (!tag) continue;
      var ce = el.getAttribute('contenteditable');
      var ceOk = ce !== null && ce !== 'false' && el.isContentEditable;
      var clickableTag = tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL' || tag === 'SUMMARY';
      if (!clickableTag && !el.hasAttribute('role') && !el.hasAttribute('onclick') && !ceOk) continue;
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
      if (rect.width < 8 || rect.height < 8) continue;
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
      if (typeof el.checkVisibility === 'function') {
        try { if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue; } catch (e) {}
      }
      var cs;
      try { cs = window.getComputedStyle(el); } catch (e) { continue; }
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
      var opacity = parseFloat(cs.opacity);
      if (!isNaN(opacity) && opacity <= 0) continue;
      var text = '';
      try { text = String(el.innerText || el.value || el.textContent || '').replace(/\\s+/g, ' ').trim(); } catch (e) {}
      var role = '';
      try { role = el.getAttribute('role') || ''; } catch (e) {}
      var token = store.tokens.get(el);
      if (!token) { token = 'n' + (++store.next); store.tokens.set(el, token); }
      store.refs.delete(token);
      store.refs.set(token, new WeakRef(el));
      while (store.refs.size > 2048) store.refs.delete(store.refs.keys().next().value);
      out.push({ nodeToken: token, targetSignature: ${targetSignature}(el), tag: String(tag).toLowerCase(), text: text, role: role, x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
    return {
      ok: true, viewport: { width: vw, height: vh },
      anchor: { scrollX: window.scrollX, scrollY: window.scrollY, href: location.href, domSig: ${domSignature}, documentEpoch: typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number' ? performance.timeOrigin : null },
      raw: out
    };
  })()`
}

function readViewport(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  const width = Number(entry.width), height = Number(entry.height)
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : null
}

function readMark(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  const x = Number(entry.x), y = Number(entry.y), width = Number(entry.width), height = Number(entry.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const tag = typeof entry.tag === 'string' ? entry.tag.trim().toLowerCase() : ''
  if (!tag) return null
  const text = typeof entry.text === 'string' ? entry.text.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  const role = typeof entry.role === 'string' ? entry.role.trim() : ''
  const rect = { x: round(x), y: round(y), width: round(width), height: round(height) }
  return {
    ...rect, centerX: round(rect.x + rect.width / 2), centerY: round(rect.y + rect.height / 2), tag,
    ...(typeof entry.nodeToken === 'string' ? { nodeToken: entry.nodeToken.slice(0, 80) } : {}),
    ...(typeof entry.targetSignature === 'string' ? { targetSignature: entry.targetSignature.slice(0, 2000) } : {}),
    ...(text ? { text } : {}), ...(role ? { role } : {}),
  }
}

function readAnchor(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  const scrollX = Number(entry.scrollX), scrollY = Number(entry.scrollY)
  const href = typeof entry.href === 'string' ? entry.href : ''
  const domSig = typeof entry.domSig === 'string' ? entry.domSig : ''
  const documentEpoch = entry.documentEpoch
  return Number.isFinite(scrollX) && Number.isFinite(scrollY) && href && domSig && typeof documentEpoch === 'number' && Number.isFinite(documentEpoch)
    ? { scrollX, scrollY, href, domSig, documentEpoch } : null
}

function overlaySource(marks: Record<string, unknown>[]): string {
  return `(function (marks) {
    var old = document.getElementById('${overlayId}');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var root = document.createElement('div');
    root.id = '${overlayId}';
    root.setAttribute('data-som-overlay', '1');
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var badge = document.createElement('div');
      badge.textContent = String(m.id);
      badge.style.cssText = 'position:fixed;pointer-events:none;left:' + m.x + 'px;top:' + m.y + 'px;' +
        'min-width:15px;height:15px;box-sizing:border-box;padding:0 3px;' +
        'background:#d92d20;color:#ffffff;font:700 11px/15px ui-monospace,Menlo,Consolas,monospace;' +
        'text-align:center;border:1px solid #ffffff;border-radius:3px;z-index:2147483647;';
      root.appendChild(badge);
    }
    (document.body || document.documentElement).appendChild(root);
    setTimeout(function () { if (root.parentNode) root.parentNode.removeChild(root); }, 15000);
    root.getBoundingClientRect();
    return true;
  })(${JSON.stringify(marks)})`
}
