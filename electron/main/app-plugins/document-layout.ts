import { BrowserWindow, net, session } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  APP_RENDER_PDF_MAX_BYTES, isAppRenderDocumentRequest, isAppRenderPdfRequest,
  type AppRenderDocumentRequest, type AppRenderDocumentResult, type AppRenderPdfErrorCode, type AppRenderDocumentRead,
} from '../../../sdk/app-plugins/src/api';

import { renderAppPdf } from './render-pdf';

export class AppDocumentLayoutError extends Error {
  constructor(readonly code: AppRenderPdfErrorCode) { super(`Document rendering failed (${code}).`); }
}

const MAX_BYTES = APP_RENDER_PDF_MAX_BYTES - 1024;
const MAX_PIXELS = 67_108_864;
const POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'application/json', 'application/pdf', 'text/html', 'text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
let active = false;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function dimension(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 16384; }
function coordinate(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 16384; }
function base64(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > MAX_BYTES || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

/** Only trusted backend code enters this no-Node, no-preload renderer; no browser handle escapes. */
export async function renderAppDocument(input: AppRenderDocumentRequest, signal: AbortSignal, source: {
  readAsset(path: string): Promise<Uint8Array>;
  read?: AppRenderDocumentRead;
}): Promise<AppRenderDocumentResult> {
  if (!isAppRenderDocumentRequest(input)) throw new AppDocumentLayoutError('invalid-request');
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw new AppDocumentLayoutError('too-large');
  if (signal.aborted) throw new AppDocumentLayoutError('cancelled');
  if (active) throw new AppDocumentLayoutError('busy');
  active = true;
  const controller = new AbortController();
  const nonce = randomUUID();
  const isolated = session.fromPartition(`app-document-layout-${nonce}`, { cache: false });
  const url = input.document ? `https://snapshot-${nonce}.invalid/${input.document.entry.path.split('/').map(encodeURIComponent).join('/')}` : `https://document-${nonce}.invalid/`;
  const binding = `documentLayout_${nonce.replace(/-/g, '')}`;
  let window: BrowserWindow | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectEnded: (error: AppDocumentLayoutError) => void = () => {};
  let contextId = 0;
  let scale = 2;
  let operationActive = false;
  let activeReads = 0;
  let completed = false;
  const stop = (code: AppRenderPdfErrorCode) => {
    controller.abort();
    completed = true;
    rejectEnded(new AppDocumentLayoutError(code));
    if (window && !window.isDestroyed()) window.destroy();
  };
  const abort = () => stop('cancelled');
  try {
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    const root = new URL(url);
    const canonical = (path: string) => path.length > 0 && path.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)
      && path.split('/').every(part => part && part !== '.' && part !== '..');
    if (!canonical(input.entry) || !/\.(?:m?js)$/.test(input.entry)) throw new AppDocumentLayoutError('invalid-request');
    const mime: Record<string, string> = { js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif', wasm: 'application/wasm' };
    const snapshot = input.document ? new Map([input.document.entry, ...input.document.resources].map(file => [file.path, {
      bytes: Buffer.from(file.data, 'base64'), mimeType: file.mimeType,
    }])) : null;
    const pendingResources = new Set<number>();
    let resourceRevision = 0;
    const resourceFinished = (details: Electron.OnCompletedListenerDetails | Electron.OnErrorOccurredListenerDetails) => {
      pendingResources.delete(details.id);
      resourceRevision++;
    };
    if (snapshot) {
      isolated.webRequest.onCompleted(resourceFinished);
      isolated.webRequest.onErrorOccurred(resourceFinished);
    }
    isolated.webRequest.onBeforeRequest((details, reply) => {
      const target = new URL(details.url);
      if (snapshot) {
        pendingResources.add(details.id);
        resourceRevision++;
        reply({ cancel: target.protocol === 'file:' || target.protocol === 'matcha-app:' }); return;
      }
      reply({ cancel: target.origin !== root.origin && target.protocol !== 'data:' && target.protocol !== 'blob:' });
    });
    isolated.protocol.handle('https', async request => {
      const target = new URL(request.url);
      if (snapshot) {
        if (target.origin !== root.origin) return net.fetch(request, { bypassCustomProtocolHandlers: true });
        if (request.method !== 'GET') return new Response(null, { status: 403 });
        let path: string;
        try {
          path = target.pathname.slice(1).split('/').map(part => {
            const decoded = decodeURIComponent(part);
            if (decoded.includes('/')) throw new Error('Invalid resource URL');
            return decoded;
          }).join('/');
        } catch { return new Response(null, { status: 400 }); }
        const file = snapshot.get(path);
        return file ? new Response(new Uint8Array(file.bytes).buffer, { headers: { 'Content-Type': file.mimeType,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "sandbox allow-scripts allow-forms; object-src 'none'; frame-src 'none'" } }) : new Response(null, { status: 404 });
      }
      if (request.method !== 'GET' || target.origin !== root.origin || target.search || target.hash) return new Response(null, { status: 403 });
      if (target.pathname === '/') return new Response(`﻿${input.html ?? '<!doctype html><html><body></body></html>'}`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': POLICY },
      });
      const path = target.pathname.slice(1);
      const type = mime[path.split('.').pop()!];
      if (!canonical(path) || !type || request.mode === 'navigate') return new Response(null, { status: 403 });
      try { return new Response(new Uint8Array(await source.readAsset(path)).buffer, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': POLICY } }); }
      catch { return new Response(null, { status: 404 }); }
    });
    window = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: {
      session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, backgroundThrottling: false, offscreen: true, navigateOnDragDrop: false, spellcheck: false,
    } });
    const owned = window;
    const contents = owned.webContents;
    const cdp = contents.debugger;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-frame-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('will-prevent-unload', event => event.preventDefault());
    const ended = new Promise<never>((_resolve, reject) => { rejectEnded = reject; });
    contents.once('render-process-gone', () => stop('render-failed'));
    owned.once('closed', () => { if (!completed) stop('render-failed'); });
    timer = setTimeout(() => stop('deadline'), 300_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const rendering = (async (): Promise<AppRenderDocumentResult> => {
      await owned.loadURL(url);
      cdp.attach('1.3');
      await cdp.sendCommand('Page.enable');
      await cdp.sendCommand('Runtime.enable');
      const { frameTree } = await cdp.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } };
      ({ executionContextId: contextId } = await cdp.sendCommand('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: binding }) as { executionContextId: number });
      await cdp.sendCommand('Runtime.addBinding', { name: binding, executionContextId: contextId });
      const evaluate = async (expression: string) => {
        const result = await cdp.sendCommand('Runtime.evaluate', { expression, contextId, awaitPromise: false });
        if (result.exceptionDetails) throw new AppDocumentLayoutError('render-failed');
      };
      const readyDocument = async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          controller.signal.throwIfAborted();
          const revision = resourceRevision;
          const readiness = await cdp.sendCommand('Runtime.evaluate', { contextId, awaitPromise: true, returnByValue: true, expression: `new Promise(async (resolve, reject) => {
            let changed = false;
            const observer = new MutationObserver(() => { changed = true; });
            observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
            const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('deadline')); }, 5000);
            try {
              await document.fonts.ready;
              await Promise.all(Array.from(document.images).map(image => image.complete ? Promise.resolve() : image.decode().catch(() => {})));
              await new Promise(done => setTimeout(done, 32));
              resolve(!changed);
            } catch (error) { reject(error); }
            finally { clearTimeout(timeout); observer.disconnect(); }
          })` });
          if (readiness.exceptionDetails) throw new AppDocumentLayoutError('render-failed');
          if (!pendingResources.size && revision === resourceRevision && readiness.result?.value === true) return;
          await new Promise<void>(resolve => setTimeout(resolve, 16));
        }
        throw new AppDocumentLayoutError('deadline');
      };
      const result = new Promise<AppRenderDocumentResult>((resolve, reject) => {
        cdp.on('message', (_event, method, params) => {
          if (method !== 'Runtime.bindingCalled' || params.name !== binding || params.executionContextId !== contextId || completed) return;
          void (async () => {
            if (typeof params.payload !== 'string' || Buffer.byteLength(params.payload) > MAX_BYTES) throw new AppDocumentLayoutError('too-large');
            const message: unknown = JSON.parse(params.payload);
            if (!record(message) || message.nonce !== nonce || !fields(message, ['nonce', 'id', 'type', 'input'])) throw new AppDocumentLayoutError('invalid-request');
            if (message.type === 'error') throw new AppDocumentLayoutError('render-failed');
            if (message.type === 'result') {
              const value = message.input;
              if (operationActive || !record(value) || !fields(value, ['data', 'mimeType']) || !base64(value.data) || typeof value.mimeType !== 'string' || !MIME_TYPES.has(value.mimeType)) throw new AppDocumentLayoutError('invalid-request');
              completed = true;
              resolve({ data: value.data, mimeType: value.mimeType });
              return;
            }
            if (!Number.isSafeInteger(message.id) || Number(message.id) <= 0) throw new AppDocumentLayoutError('invalid-request');
            if (message.type === 'read') {
              if (!source.read || activeReads >= 32) throw new AppDocumentLayoutError('busy');
              activeReads++;
              try {
                const value = await source.read(message.input as Parameters<AppRenderDocumentRead>[0], controller.signal);
                if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new AppDocumentLayoutError('too-large');
                await evaluate(`globalThis.__documentLayoutReply(${JSON.stringify({ id: message.id, result: value })})`);
              } catch (error) {
                if (error instanceof AppDocumentLayoutError) throw error;
                await evaluate(`globalThis.__documentLayoutReply(${JSON.stringify({ id: message.id, error: 'read-failed' })})`);
              } finally { activeReads--; }
              return;
            }
            if (operationActive) throw new AppDocumentLayoutError('busy');
            operationActive = true;
            let value: unknown;
            try {
              const request = message.input;
              if (!record(request)) throw new AppDocumentLayoutError('invalid-request');
              if (message.type === 'viewport') {
                if (!fields(request, ['width', 'height', 'deviceScaleFactor']) || !dimension(request.width) || !dimension(request.height)
                  || typeof request.deviceScaleFactor !== 'number' || request.deviceScaleFactor < 1 || request.deviceScaleFactor > 2
                  || request.width * request.height * request.deviceScaleFactor ** 2 > MAX_PIXELS) throw new AppDocumentLayoutError('invalid-request');
                scale = request.deviceScaleFactor;
                owned.setContentSize(request.width, request.height);
                await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { ...request, mobile: false });
              } else if (message.type === 'ready' && snapshot) {
                if (!fields(request, [])) throw new AppDocumentLayoutError('invalid-request');
                await readyDocument();
              } else if (message.type === 'print' && snapshot) {
                if (!fields(request, ['options']) || !isAppRenderPdfRequest({ html: '<!doctype html>', ...(request.options === undefined ? {} : { options: request.options }) })) throw new AppDocumentLayoutError('invalid-request');
                await readyDocument();
                const pdf = await contents.printToPDF((request.options ?? {}) as NonNullable<import('../../../sdk/app-plugins/src/api').AppRenderPdfRequest['options']>);
                if (!pdf.length || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new AppDocumentLayoutError('render-failed');
                const data = pdf.toString('base64');
                if (!base64(data)) throw new AppDocumentLayoutError('too-large');
                value = { data, mimeType: 'application/pdf' };
              } else if (message.type === 'pdf') {
                if (!fields(request, ['request']) || !isAppRenderPdfRequest(request.request)) throw new AppDocumentLayoutError('invalid-request');
                value = await renderAppPdf(request.request, controller.signal);
              } else if (message.type === 'screenshot') {
                if (!fields(request, ['clip', 'omitBackground']) || request.omitBackground !== undefined && typeof request.omitBackground !== 'boolean') throw new AppDocumentLayoutError('invalid-request');
                const clip = request.clip;
                if (clip !== undefined && (!record(clip) || !fields(clip, ['x', 'y', 'width', 'height']) || !coordinate(clip.x) || !coordinate(clip.y)
                  || !dimension(clip.width) || !dimension(clip.height) || clip.width * clip.height * scale ** 2 > MAX_PIXELS
                  || clip.x + clip.width > 16384 || clip.y + clip.height > 16384)) throw new AppDocumentLayoutError('too-large');
                if (request.omitBackground) await cdp.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
                try {
                  const shot = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
                    ...(record(clip) ? { clip: { ...clip, scale: 1 } } : {}) }) as { data: string };
                  if (!base64(shot.data)) throw new AppDocumentLayoutError('too-large');
                  value = shot.data;
                } finally {
                  if (request.omitBackground) await cdp.sendCommand('Emulation.setDefaultBackgroundColorOverride', {});
                }
              } else throw new AppDocumentLayoutError('invalid-request');
              operationActive = false;
              await evaluate(`globalThis.__documentLayoutReply(${JSON.stringify({ id: message.id, result: value ?? null })})`);
            } finally { operationActive = false; }
          })().catch(error => { reject(error); stop(error instanceof AppDocumentLayoutError ? error.code : 'render-failed'); });
        });
      });
      // The fixed bootstrap owns the binding; the supplied bundle gets only a local DOM port.
      await evaluate(`(() => {
        const channel = new MessageChannel();
        const send = globalThis[${JSON.stringify(binding)}];
        channel.port1.onmessage = ({data}) => send(JSON.stringify({...data, nonce:${JSON.stringify(nonce)}}));
        channel.port1.start();
        globalThis.__documentLayoutReply = value => channel.port1.postMessage(value);
        globalThis.__documentLayoutPort = channel.port2;
      })()`);
      if (snapshot) {
        const worker = await source.readAsset(input.entry);
        if (worker.byteLength > MAX_BYTES) throw new AppDocumentLayoutError('too-large');
        const entry = `data:text/javascript;base64,${Buffer.from(worker).toString('base64')}`;
        await evaluate(`import(${JSON.stringify(entry)}).then(module => module.documentRenderer(${JSON.stringify({ document: true, payload: input.payload })},globalThis.__documentLayoutPort)).catch(() => globalThis[${JSON.stringify(binding)}](JSON.stringify({nonce:${JSON.stringify(nonce)},type:'error'})))`);
      } else {
        await evaluate(`import(${JSON.stringify(new URL(input.entry, url).href)}).then(module => module.documentRenderer(${JSON.stringify({ html: input.html, payload: input.payload })},globalThis.__documentLayoutPort)).catch(() => globalThis[${JSON.stringify(binding)}](JSON.stringify({nonce:${JSON.stringify(nonce)},type:'error'})))`);
      }
      return result;
    })();
    return await Promise.race([rendering, ended]);
  } catch (error) {
    if (signal.aborted) throw new AppDocumentLayoutError('cancelled');
    throw error instanceof AppDocumentLayoutError ? error : new AppDocumentLayoutError('render-failed');
  } finally {
    completed = true;
    controller.abort();
    signal.removeEventListener('abort', abort);
    clearTimeout(timer);
    if (window && !window.isDestroyed()) {
      try { await window.webContents.debugger.sendCommand('Runtime.removeBinding', { name: binding }); } catch { /* renderer ended */ }
      try { window.webContents.debugger.detach(); } catch { /* already detached */ }
      window.destroy();
    }
    isolated.webRequest.onBeforeRequest(null);
    if (input.document) {
      isolated.webRequest.onCompleted(null);
      isolated.webRequest.onErrorOccurred(null);
    }
    isolated.protocol.unhandle('https');
    await isolated.clearStorageData().catch(() => {});
    active = false;
  }
}
