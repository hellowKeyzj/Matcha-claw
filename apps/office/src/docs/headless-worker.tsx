import '../platform/browser-storage';
import { createRoot } from 'react-dom/client';
import type { AppJson, AppRenderPdfRequest, AppRenderPdfResult } from '@matcha/app-plugins-sdk';
import { App } from '../../genoffice/apps/docs/src/renderer/App';
import { LocaleProvider, setModuleLang } from '../../genoffice/apps/docs/src/renderer/i18n/locale';
import { setAltChunkHtmlConverter } from '../../genoffice/packages/docx-engine/src';
import { MARKDOWN_MEDIA_DIR_TOKEN } from '../../genoffice/apps/docs/src/shared/ipc';
import type { DesktopApi } from './types';
import { installDesktopBridge } from './desktop';
import { createDocsExports } from './export';
import { base64ToBytes, bytesToBase64 } from '../documents/client';
import '../../genoffice/packages/ui/src/tokens.css';
import '../../genoffice/apps/docs/src/renderer/styles.css';
import '../../genoffice/apps/docs/src/renderer/fonts/fonts.css';
import './page.css';

type Payload = { data: string; format: 'pdf' | 'html' | 'md'; chunks: Record<string, string> };
export async function documentRenderer({ payload }: { payload?: Payload }, port: MessagePort): Promise<void> {
  if (!payload) throw new Error('Missing Docs export input.');
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  port.onmessage = ({ data }: MessageEvent<{ id: number; result: unknown; error?: string }>) => {
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error)); else item.resolve(data.result);
  };
  port.start();
  const request = <T,>(type: 'pdf' | 'read', input: AppJson | { request: AppRenderPdfRequest }): Promise<T> => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: value => resolve(value as T), reject });
    port.postMessage({ id, type, input });
  });
  const renderPdf = (input: AppRenderPdfRequest) => request<AppRenderPdfResult>('pdf', { request: input });
  setAltChunkHtmlConverter(async html => {
    const data = payload.chunks[html];
    if (!data) throw new Error('An altChunk was not converted before export.');
    return base64ToBytes(data);
  });
  let output: { data: string; mimeType: string } | undefined;
  let consumed = false;
  const noEvents = () => () => {};
  // Eager font prefetch must stay below the Host's 32 concurrent-read limit.
  let fontTail = Promise.resolve();
  const desktop = installDesktopBridge({
    fontMetrics: family => {
      const result = fontTail.then(() => request<Awaited<ReturnType<DesktopApi['fontMetrics']>>>('read', family));
      fontTail = result.then(() => {}, () => {});
      return result;
    },
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
    getRecentFiles: async () => [],
    consumePendingOpenDocx: async () => {
      if (consumed) return null;
      consumed = true;
      return { path: 'matcha-office://export/document.docx', name: 'document.docx', hash: '', dataUrl: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${payload.data}` };
    },
    consumeNewBlankDoc: async () => false,
    consumeHeadlessExport: async () => ({ outPath: 'office-export:headless', format: payload.format }),
    headlessExportDone: report => {
      if (!report.ok || !output) port.postMessage({ type: 'error' });
      else port.postMessage({ type: 'result', input: output });
      port.close();
    },
    docPasswordIntentRevision: async () => 0,
    discardDocPasswordIntents: async () => ({ ok: true }),
    writeRecoveryCopy: async () => ({ ok: true }),
    onZoteroRequest: noEvents,
    onContextMenuRequest: noEvents,
    armContextMenu: () => {},
    claimContextMenu: () => {},
    respellKick: async () => {},
    spellLanguages: async () => ({ active: [], available: [] }),
    ...createDocsExports((bytes, mimeType) => { output = { data: bytesToBase64(bytes), mimeType }; }, renderPdf),
    exportMarkdown: async (_name, markdown, images, outPath) => {
      for (const image of images) {
        let src = image.src;
        if (!src.startsWith('data:')) {
          const response = await fetch(src);
          if (!response.ok) throw new Error('Unable to read Markdown image.');
          src = `data:${response.headers.get('content-type') ?? 'application/octet-stream'};base64,${bytesToBase64(new Uint8Array(await response.arrayBuffer()))}`;
        }
        markdown = markdown.split(`${MARKDOWN_MEDIA_DIR_TOKEN}/${image.name}`).join(src);
      }
      output = { data: bytesToBase64(new TextEncoder().encode(markdown)), mimeType: 'text/markdown' };
      return { ok: true, path: outPath };
    },
  }, true);
  setModuleLang(await desktop.getLanguage());
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing Docs export root.');
  createRoot(root).render(<LocaleProvider initial="en"><App /></LocaleProvider>);
};
