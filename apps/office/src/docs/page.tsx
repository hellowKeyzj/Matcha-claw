import '../platform/browser-storage';
import { createRoot } from 'react-dom/client';
import { showOfficeSettings } from '../settings/dialog';
import { settingsLabels } from '../settings/labels';
import { App } from '../../genoffice/apps/docs/src/renderer/App';
import { htmlDir, htmlLang } from '../../genoffice/packages/i18n/src';
import { applyAiPanelPrefs, installScreenTips } from '../../genoffice/packages/ui/src';
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
import '../../genoffice/packages/ui/src/image-viewer.css';
import { LocaleProvider, setModuleLang } from '../../genoffice/apps/docs/src/renderer/i18n/locale';
import { installDesktopBridge } from './desktop';
import { setAltChunkHtmlConverter } from '../../genoffice/packages/docx-engine/src';
import { setAuthorName } from '../../genoffice/apps/docs/src/renderer/author-name';
import '../../genoffice/apps/docs/src/renderer/styles.css';
import '../../genoffice/apps/docs/src/renderer/fonts/fonts.css';
import './page.css';

function SettingsButton() {
  return (
    <button type="button" className="ribbon-tab" onClick={() => { void showOfficeSettings().catch(console.error); }}>{settingsLabels().settings}</button>
  );
}

async function start(): Promise<void> {
  const desktop = installDesktopBridge();
  const language = await desktop.getLanguage();
  setAltChunkHtmlConverter((html) => desktop.convertAltChunkHtml(html));
  const applyDocumentTheme = (theme: Awaited<ReturnType<typeof desktop.getDocumentTheme>>) => {
    if (theme === 'follow') document.documentElement.removeAttribute('data-doc-theme');
    else document.documentElement.setAttribute('data-doc-theme', theme);
  };
  applyDocumentTheme(await desktop.getDocumentTheme());
  const offDocumentTheme = desktop.onDocumentThemeChanged(applyDocumentTheme);
  setAuthorName(await desktop.getAuthorName());
  const offAuthor = desktop.onAuthorNameChanged(setAuthorName);
  applyAiPanelPrefs(await desktop.getAiPanelPrefs());
  const offAiPanelPrefs = desktop.onAiPanelPrefsChanged(applyAiPanelPrefs);
  window.addEventListener('pagehide', () => {
    offDocumentTheme();
    offAuthor();
    offAiPanelPrefs();
  }, { once: true });
  setModuleLang(language);
  installScreenTips();
  document.documentElement.lang = htmlLang(language);
  document.documentElement.dir = htmlDir(language);
  const root = document.getElementById('root');
  if (!root) throw new Error('Docs root element is missing.');
  createRoot(root).render(
    <LocaleProvider initial={language}>
      <App trailingActions={<SettingsButton />} />
    </LocaleProvider>,
  );
}

void start().catch(console.error);
