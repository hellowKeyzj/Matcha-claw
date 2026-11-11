import { convertHtmlToDocx } from '../../genoffice/packages/html2docx/src/convert';
import type { BrowserDriver, ScreenshotOptions, Viewport } from '../../genoffice/packages/html2docx/src/driver';

type Reply = { id: number; result?: unknown; error?: string };
type WorkerInput = { html?: string; document?: boolean; payload?: { format?: string; naturalTableWidth?: boolean } };
function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function documentRenderer({ html, document: dynamic, payload }: WorkerInput, port: MessagePort): Promise<void> {
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  port.onmessage = ({ data }: MessageEvent<Reply>) => {
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error)); else item.resolve(data.result);
  };
  port.start();
  const request = <T>(type: string, input: unknown): Promise<T> => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: value => resolve(value as T), reject });
    port.postMessage({ id, type, input });
  });
  let loaded = false;
  const driver: BrowserDriver = {
    setViewport: (viewport: Viewport) => request<void>('viewport', viewport),
    async goto(_url, { timeoutMs }) {
      if (dynamic) { await request<void>('ready', {}); return; }
      if (loaded) {
        // document.open() removes JSZip's window message listener and stalls packing.
        const parsed = new DOMParser().parseFromString(html ?? '', 'text/html');
        for (const script of parsed.querySelectorAll('script')) script.remove();
        const waits = [...parsed.querySelectorAll<HTMLLinkElement | HTMLImageElement>('link[rel="stylesheet"], img:not([loading="lazy"])')].map(element => new Promise<void>(resolve => {
          element.addEventListener('load', () => resolve(), { once: true });
          element.addEventListener('error', () => resolve(), { once: true });
        }));
        document.documentElement.replaceWith(document.adoptNode(parsed.documentElement));
        scrollTo(0, 0);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.all(waits), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
        clearTimeout(timer);
      }
      loaded = true;
      if (document.readyState !== 'complete') await new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        function done() { clearTimeout(timer); window.removeEventListener('load', done); resolve(); }
        window.addEventListener('load', done, { once: true });
      });
    },
    evaluate: <T>(fn: string | ((arg?: any) => T | Promise<T>), arg?: unknown) => Promise.resolve(
      (0, eval)(typeof fn === 'string' ? fn : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`) as T,
    ),
    async addScript(source) { (0, eval)(source); },
    async addInitScript() { throw new Error('Conversion tracing is not enabled.'); },
    async screenshot(options: ScreenshotOptions) {
      const data = await request<string>('screenshot', options);
      return Uint8Array.from(atob(data), value => value.charCodeAt(0));
    },
    async screenshotElement(selector, options) {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const clip = { x: Math.max(0, Math.round(rect.left + scrollX)), y: Math.max(0, Math.round(rect.top + scrollY)), width: Math.round(rect.width), height: Math.round(rect.height) };
      return clip.width > 0 && clip.height > 0 ? driver.screenshot({ ...options, clip }) : null;
    },
    elementExists: async selector => document.querySelector(selector) !== null,
    async close() {},
  };
  try {
    if (payload?.format === 'docx') {
      const { docx } = await convertHtmlToDocx({ url: 'about:blank' }, driver, { naturalTableWidth: payload.naturalTableWidth });
      port.postMessage({ type: 'result', input: { data: encode(docx), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
    } else if (payload?.format === 'pdf' && dynamic) {
      await driver.goto('about:blank', { timeoutMs: 30_000 });
      const pdf = await request<{ data: string; mimeType: 'application/pdf' }>('print', {
        options: { pageSize: 'A4', printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } }
      });
      port.postMessage({ type: 'result', input: pdf });
    } else if (payload?.format === 'png') {
      await driver.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
      await driver.goto('about:blank', { timeoutMs: 30_000 });
      await document.fonts.ready;
      for (const image of document.images) image.loading = 'eager';
      const originalY = scrollY;
      for (let y = 0; y < document.documentElement.scrollHeight; y += 675) {
        scrollTo(0, y);
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
      scrollTo(0, originalY);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (dynamic) await request<void>('ready', {});
      const width = Math.max(innerWidth, document.documentElement.scrollWidth, document.body.scrollWidth);
      const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const png = await driver.screenshot({ clip: { x: 0, y: 0, width, height } });
      port.postMessage({ type: 'result', input: { data: encode(png), mimeType: 'image/png' } });
    } else throw new Error('Unsupported document conversion format.');
  } catch {
    port.postMessage({ type: 'error' });
  } finally { port.close(); }
};
