import type { AppPluginContext, AppToolHandler, AppToolResult } from '@matcha/app-plugins-sdk';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureAppPaths } from './platform/electron-main';
import { createBrowserPreferences } from './platform/browser-preferences';
import { createOfficeSettings } from './settings/store';
import { OfficeError, errorMessage } from './errors';
import { createDocumentService } from './documents/service';
import { createDocumentTools } from './documents/tools';
import { createSheetsSession } from './sheets/session';
import { initializeSheetsRuntime } from './sheets/runtime';
import { createSheetsTools } from './sheets/tools';
import { createSlidesSession } from './slides/session';
import { createSlidesTools } from './slides/tools';
import { createDocsSession } from './docs/session';
import { createDocsTools } from './docs/tools';
import { createPdfSession } from './pdf/session';
import { createPdfTools } from './pdf/tools';
import { createMarkdownSession } from './markdown/session';
import { createMarkdownTools } from './markdown/tools';
import { createHtmlSession } from './html/session';
import { createHtmlTools } from './html/tools';

export async function activate(context: AppPluginContext): Promise<() => Promise<void>> {
  configureAppPaths({ userData: context.storagePath, temp: tmpdir(), documents: context.storagePath });
  const sidecar = join(context.packagePath, 'native', process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar');
  if (existsSync(sidecar)) process.env.XLSX_SIDECAR_PATH = sidecar;
  await initializeSheetsRuntime(context);
  const documents = createDocumentService(context);
  const sheets = createSheetsSession(context, documents.editorHooks('xlsx'));
  const slides = createSlidesSession(context, documents.editorHooks('pptx'));
  const docs = createDocsSession(context, documents);
  const pdf = createPdfSession(context, documents);
  const markdown = createMarkdownSession(context, documents);
  const html = createHtmlSession(context, documents);
  const tools: Record<string, AppToolHandler> = {
    ...createDocumentTools(documents),
    ...createSheetsTools(documents, sheets),
    ...createSlidesTools(documents, slides),
    ...createDocsTools(docs),
    ...createPdfTools(documents, pdf),
    ...createMarkdownTools(documents, markdown),
    ...createHtmlTools(documents, html)
  };
  const browserPreferences = createBrowserPreferences(context.storagePath);
  const settings = createOfficeSettings(context);
  const editorTools = new Set(['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'].map(app => `office_${app}_ipc`));
  function sharedSettings(name: string, input: Record<string, unknown>): AppToolResult | undefined {
    if (!editorTools.has(name) || (input.channel !== 'office:settings:get' && input.channel !== 'office:settings:set')) return;
    try {
      const result = settings.call(input.channel, input.arguments as unknown[]);
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { result } };
    } catch (error) {
      const message = errorMessage(error);
      return { content: [{ type: 'text', text: message }], isError: true,
        structuredContent: { code: error instanceof OfficeError ? error.code : 'settings_failed', error: message } };
    }
  }
  const active = new Set<Promise<AppToolResult>>();
  let accepting = true;
  const disposers = Object.entries(tools).map(([name, handler]) => context.registerTool(name, async (input, tool) => {
    if (!accepting) throw new Error('Matcha Office is closing.');
    const operation = Promise.resolve().then(() => browserPreferences(name, input) ?? sharedSettings(name, input) ?? handler(input, tool));
    active.add(operation);
    try {
      return await operation;
    } finally {
      active.delete(operation);
    }
  }));

  context.log.info(`Matcha Office ${context.version} ready.`);
  return async () => {
    accepting = false;
    for (const dispose of disposers.reverse()) dispose();
    docs.beginClose();
    pdf.beginClose();
    slides.beginClose();
    await Promise.all([sheets.beginClose(), html.beginClose(), markdown.dispose()]);
    await Promise.allSettled([...active]);
    await Promise.all([docs.dispose(), sheets.dispose(), slides.dispose(), pdf.dispose(), html.dispose()]);
  };
}
