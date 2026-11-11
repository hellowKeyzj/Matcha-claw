import { BrowserWindow, ipcMain, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { APP_RENDER_PDF_MAX_BYTES, isAppRenderPdfRequest, type AppRenderPdfErrorCode, type AppRenderPdfRequest, type AppRenderPdfResult } from '../../../sdk/app-plugins/src/api';

export class AppRenderPdfError extends Error {
  constructor(readonly code: AppRenderPdfErrorCode) { super(`PDF rendering failed (${code}).`); }
}

// Covers the MessagePort result wrapper as well as the backend service envelope.
const ENVELOPE_RESERVE_BYTES = 1024;
const PDF_POLICY = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; worker-src 'none'";
const PDF_READY_SCRIPT = `Promise.all([
  document.fonts.ready,
  ...Array.from(document.images).map((image) => image.decode()),
  ...Array.from(document.querySelectorAll('svg image')).map((element) => {
    const href = element.getAttribute('href') || element.getAttribute('xlink:href');
    if (!href) return Promise.resolve();
    const image = new Image();
    image.src = href;
    return image.decode();
  }),
]).then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))`;
let active = false;

export async function renderAppPdf(input: AppRenderPdfRequest, signal: AbortSignal): Promise<AppRenderPdfResult> {
  if (!isAppRenderPdfRequest(input)) throw new AppRenderPdfError('invalid-request');
  if (Buffer.byteLength(JSON.stringify(input)) + ENVELOPE_RESERVE_BYTES > APP_RENDER_PDF_MAX_BYTES) throw new AppRenderPdfError('too-large');
  if (signal.aborted) throw new AppRenderPdfError('cancelled');
  if (active) throw new AppRenderPdfError('busy');
  active = true;
  const isolated = session.fromPartition(`app-render-pdf-${randomUUID()}`, { cache: false });
  let window: BrowserWindow | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stop: (error: AppRenderPdfError) => void = () => {};
  const abort = () => stop(new AppRenderPdfError('cancelled'));
  try {
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    const documentUrl = `https://app-render-pdf.invalid/${randomUUID()}`;
    isolated.protocol.handle('https', (request) => request.url === documentUrl
      ? new Response(input.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PDF_POLICY } })
      : new Response(null, { status: 403 }));
    isolated.webRequest.onBeforeRequest((details, reply) => reply({ cancel: details.url !== documentUrl && !details.url.startsWith('data:') }));
    window = new BrowserWindow({
      show: false,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, webSecurity: true, navigateOnDragDrop: false, spellcheck: false, backgroundThrottling: false },
    });
    const owned = window;
    const contents = owned.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    const ended = new Promise<never>((_resolve, reject) => {
      stop = (error) => { if (!owned.isDestroyed()) owned.destroy(); reject(error); };
      contents.once('render-process-gone', () => stop(new AppRenderPdfError('render-failed')));
      timeout = setTimeout(() => stop(new AppRenderPdfError('deadline')), 300_000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const result = await Promise.race([
      (async () => {
        await owned.loadURL(documentUrl);
        // Only this fixed Host script runs; response CSP blocks all input scripts.
        await contents.executeJavaScriptInIsolatedWorld(999, [{ code: PDF_READY_SCRIPT }]);
        signal.throwIfAborted();
        const pdf = await contents.printToPDF(input.options ?? {});
        signal.throwIfAborted();
        if (!pdf.length || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new AppRenderPdfError('render-failed');
        if (4 * Math.ceil(pdf.length / 3) + ENVELOPE_RESERVE_BYTES > APP_RENDER_PDF_MAX_BYTES) throw new AppRenderPdfError('too-large');
        return { data: pdf.toString('base64'), mimeType: 'application/pdf' as const };
      })(),
      ended,
    ]);
    return result;
  } catch (error) {
    if (signal.aborted) throw new AppRenderPdfError('cancelled');
    throw error instanceof AppRenderPdfError ? error : new AppRenderPdfError('render-failed');
  } finally {
    signal.removeEventListener('abort', abort);
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    isolated.webRequest.onBeforeRequest(null);
    isolated.protocol.unhandle('https');
    active = false;
  }
}

export function registerAppRenderPdfHandlers(getMainWindow: () => BrowserWindow | null, shutdownSignal: AbortSignal): void {
  const pending = new Map<string, AbortController>();
  ipcMain.handle('app-plugins:render-pdf', async (event, requestId: unknown, input: unknown) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || shutdownSignal.aborted || typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId) || !isAppRenderPdfRequest(input)) {
      return { outcome: 'failed', code: 'invalid-request' };
    }
    if (pending.size) return { outcome: 'failed', code: 'busy' };
    const controller = new AbortController();
    pending.set(requestId, controller);
    const abort = () => controller.abort();
    shutdownSignal.addEventListener('abort', abort, { once: true });
    event.sender.once('destroyed', abort);
    try {
      return { outcome: 'rendered', result: await renderAppPdf(input, controller.signal) };
    } catch (error) {
      return { outcome: 'failed', code: error instanceof AppRenderPdfError ? error.code : 'render-failed' };
    } finally {
      pending.delete(requestId);
      shutdownSignal.removeEventListener('abort', abort);
      event.sender.removeListener('destroyed', abort);
    }
  });
  ipcMain.handle('app-plugins:render-pdf-cancel', (event, requestId: unknown) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && typeof requestId === 'string') pending.get(requestId)?.abort();
  });
}
