import ReactDOM from 'react-dom/client';
import { libraryLabels } from '../ui/choose-document';
import '../ui/dialogs.css';
import { installSheetsBridge } from './bridge';
import { sheetsLabels } from './labels';
import { showOfficeSettings } from '../settings/dialog';
import { settingsLabels } from '../settings/labels';
import { htmlDir, htmlLang, type Lang } from '../../genoffice/packages/i18n/src';
import { applyAiPanelPrefs, DEFAULT_AI_PANEL_PREFS, installScreenTips } from '../../genoffice/packages/ui/src';

import '../../genoffice/packages/ui/src/tokens.css';
import '../../genoffice/packages/ui/src/screentip.css';
import '../../genoffice/packages/ui/src/ai-model-picker.css';
import '../../genoffice/packages/ui/src/ai-queue-strip.css';
import '../../genoffice/packages/ui/src/ai-usage.css';
import '../../genoffice/packages/ui/src/ai-skills.css';
import '../../genoffice/packages/ui/src/color-picker.css';
import '../../genoffice/packages/ui/src/dropdown.css';
import '../../genoffice/packages/ui/src/ribbon-collapse.css';
import '../../genoffice/packages/ui/src/markdown.css';
import '../../genoffice/packages/ui/src/ai-panel-prefs.css';
import '../../genoffice/packages/ui/src/ai-scope-quote.css';
import '@univerjs/preset-sheets-core/lib/index.css';

import { App } from '@matcha/sheets-app';
import { installCanvasFontFallback, registerTextDingbatsFace, untilCellFontsLoaded } from '@matcha/sheets-fonts';
import { LocaleProvider, setModuleLang } from '@matcha/sheets-locale';
import type { DocTheme } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import '../../genoffice/apps/sheets/src/renderer/styles.css';
import './page.css';

const root = document.getElementById('root');
if (!root) throw new Error('Sheets root element is missing.');

const bridge = installSheetsBridge();

installScreenTips();
installCanvasFontFallback();

function applyDocumentTheme(theme: DocTheme): void {
  if (theme === 'follow') document.documentElement.removeAttribute('data-doc-theme');
  else document.documentElement.setAttribute('data-doc-theme', theme);
}

async function loadCellFonts(): Promise<void> {
  const loads: Promise<unknown>[] = [registerTextDingbatsFace()];
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) {
    for (const family of ['Calibri', 'Aptos', "'Aptos Narrow'", 'Carlito']) {
      loads.push(document.fonts?.load?.(`${variant}16px ${family}`)?.catch(() => {}) ?? []);
    }
  }
  await untilCellFontsLoaded(Promise.all(loads));
}

async function bootstrap(): Promise<void> {
  await bridge.openEditor();
  let lang: Lang = 'zh';
  let docTheme: DocTheme = 'follow';
  try {
    [lang, docTheme] = await Promise.all([
      window.desktopApi.getLanguage().catch(() => 'zh' as const),
      window.desktopApi.getDocumentTheme?.().catch(() => 'follow' as const)
    ]);
  } catch {
    /* no bridge */
  }
  setModuleLang(lang);
  document.documentElement.lang = htmlLang(lang);
  document.documentElement.dir = htmlDir(lang);
  applyDocumentTheme(docTheme ?? 'follow');
  await loadCellFonts();
  const queuedWorkbookAtBoot = await window.desktopApi?.hasQueuedWorkbook?.().catch(() => false);
  const offDocumentTheme = window.desktopApi.onDocumentThemeChanged(applyDocumentTheme);
  window.addEventListener('pagehide', offDocumentTheme, { once: true });
  applyAiPanelPrefs({ ...DEFAULT_AI_PANEL_PREFS, showAiSidebar: false });
  const labels = sheetsLabels();
  const fileActions = [['save', labels.save], ['save-as', labels.copy], ['export-pdf', labels.pdf], ['export-csv', labels.csv]] as const;
  ReactDOM.createRoot(root!).render(
    <LocaleProvider initial={lang}>
      <div className="matcha-sheets-page">
        <div className="matcha-sheets-toolbar">
          <button type="button" onClick={() => {
            bridge.dispatchMenuAction('open');
          }}>{libraryLabels().xlsx}</button>
          {fileActions.map(([action, label]) => <button key={action} type="button" onClick={() => bridge.dispatchMenuAction(action)}>{label}</button>)}
          <button type="button" onClick={() => { void showOfficeSettings().catch(console.error); }}>{settingsLabels().settings}</button>
        </div>
        <App queuedWorkbookAtBoot={queuedWorkbookAtBoot === true} />
      </div>
    </LocaleProvider>
  );
  bridge.openInitial();
}

void bootstrap().catch(console.error);
