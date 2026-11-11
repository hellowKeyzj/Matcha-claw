import '../platform/browser-storage';
import '../../genoffice/apps/sheets/src/preload/index';
import { createRoot } from 'react-dom/client';
import { App } from '@matcha/sheets-app';
import { LocaleProvider, setModuleLang } from '@matcha/sheets-locale';
import { installCanvasFontFallback, registerTextDingbatsFace, untilCellFontsLoaded } from '@matcha/sheets-fonts';
import { applyAiPanelPrefs, DEFAULT_AI_PANEL_PREFS } from '../../genoffice/packages/ui/src';
import type { WorkbookFile, WorkbookExportPdfRequest } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import { bindSheetsPdfPort } from './pdf-preload';
import '../../genoffice/packages/ui/src/tokens.css';
import '@univerjs/preset-sheets-core/lib/index.css';
import '../../genoffice/apps/sheets/src/renderer/styles.css';

type Input = { payload?: { file?: WorkbookFile } };
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function documentRenderer({ payload }: Input, port: MessagePort): Promise<void> {
  const unbind = bindSheetsPdfPort(port);
  try {
    if (!payload?.file) throw new Error('Sheets PDF workbook is missing.');
    const file = payload.file;
    const desktop = window.desktopApi;
    Reflect.deleteProperty(window, 'projectApi');
    let job: WorkbookExportPdfRequest | undefined;
    let settle!: (report: { ok: boolean; error?: string }) => void;
    const finished = new Promise<{ ok: boolean; error?: string }>((resolve) => { settle = resolve; });
    let selected = false;
    Object.assign(desktop, {
      selectWorkbook: async () => { if (selected) return null; selected = true; return file; },
      hasQueuedWorkbook: async () => !selected,
      consumeNewBlankWorkbook: async () => false,
      consumeHeadlessExport: async () => 'workbook.pdf',
      headlessExportDone: settle,
      exportPdf: async (request: WorkbookExportPdfRequest) => { job = request; return { canceled: false, path: 'workbook.pdf' }; },
      getAiSettings: async () => null,
      onAiSettingsChanged: () => () => {},
      getLanguage: async () => 'en',
      getTheme: async () => 'light',
      getDocumentTheme: async () => 'light',
      getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
      getAiPanelPrefs: async () => ({ ...DEFAULT_AI_PANEL_PREFS, showAiSidebar: false }),
      getUserDisplayName: async () => '',
    });
    installCanvasFontFallback();
    setModuleLang('en');
    document.documentElement.lang = 'en';
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.docTheme = 'light';
    applyAiPanelPrefs({ ...DEFAULT_AI_PANEL_PREFS, showAiSidebar: false });
    await untilCellFontsLoaded(registerTextDingbatsFace());
    const container = document.createElement('div');
    container.style.cssText = 'width:1440px;height:900px';
    document.body.append(container);
    const root = createRoot(container);
    root.render(<LocaleProvider initial="en"><App queuedWorkbookAtBoot /></LocaleProvider>);
    const report = await finished;
    if (!report.ok || !job) throw new Error(report.error ?? 'Sheets PDF layout failed.');
    port.postMessage({ type: 'result', input: { data: encode(JSON.stringify(job)), mimeType: 'application/json' } });
  } catch (error) {
    port.postMessage({ type: 'error', input: { message: error instanceof Error ? error.message : 'Sheets PDF layout failed.' } });
  } finally {
    // Host destroys this one-shot renderer; backend finally closes its native session.
    unbind();
  }
}
