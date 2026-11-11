import { StrictMode } from 'react';
import { showOfficeSettings } from '../settings/dialog';
import { settingsLabels } from '../settings/labels';
import { createRoot } from 'react-dom/client';
import { installSlidesBridge } from './bridge';
import { appApi } from '../documents/client';
import '../ui/dialogs.css';
import { htmlDir, htmlLang, normalizeLang } from '../../genoffice/packages/i18n/src';
import {
  applyAiPanelPrefs,
  DEFAULT_AI_PANEL_PREFS,
  installScreenTips
} from '../../genoffice/packages/ui/src';
import { LocaleProvider, setModuleLang, useI18n } from '../../genoffice/apps/slides/src/renderer/i18n/locale';
import { App } from '@matcha/slides-app';
import { AudienceView } from '@matcha/slides-audience';
import { syncPrivateFonts } from '../../genoffice/apps/slides/src/renderer/doc-fonts';

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
import '../../genoffice/apps/slides/src/renderer/styles.css';
import './page.css';

function SettingsButton() {
  const { lang } = useI18n();
  const labels: Partial<Record<string, string>> = { zh: 'Office 设置', en: 'Office settings', ja: 'Office 設定', ru: 'Настройки Office' };
  const label = labels[lang] ?? settingsLabels().settings;
  return (
    <button type="button" className="ribbon-tab" onClick={() => { void showOfficeSettings().catch(console.error); }}>{label}</button>
  );
}

async function start(): Promise<void> {
  const api = appApi();
  const language = normalizeLang(api.context.language);
  await installSlidesBridge(language);
  const activeLanguage = await window.slidesApi.getLanguage();
  if ((api.context.presentation?.data as { mode?: string } | undefined)?.mode === 'audience') {
    await syncPrivateFonts();
    window.slidesApi.onFontsChanged(() => { void syncPrivateFonts(); });
  }

  setModuleLang(activeLanguage);
  document.documentElement.lang = htmlLang(activeLanguage);
  document.documentElement.dir = htmlDir(activeLanguage);
  applyAiPanelPrefs({ ...DEFAULT_AI_PANEL_PREFS, showAiSidebar: false });
  installScreenTips();

  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) {
    document.fonts?.load?.(`${variant}16px Carlito`).catch(() => {});
    document.fonts?.load?.(`${variant}16px 'Carlito GO'`).catch(() => {});
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('Slides root element is missing.');
  createRoot(root).render(
    <StrictMode>
      <LocaleProvider initial={activeLanguage}>
        {(api.context.presentation?.data as { mode?: string } | undefined)?.mode === 'audience' ? <AudienceView /> : <App trailingActions={<SettingsButton />} />}
      </LocaleProvider>
    </StrictMode>
  );
}

void start().catch(console.error);
