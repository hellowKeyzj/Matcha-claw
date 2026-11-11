import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@matcha/pdf-app';
import { LocaleProvider, useI18n } from '@matcha/pdf-locale';
import { htmlDir, htmlLang } from '../../genoffice/packages/i18n/src';
import { applyAiPanelPrefs, installScreenTips } from '../../genoffice/packages/ui/src';
import { installPdfBridge, type PdfProducts, type PdfProgress } from './bridge';
import { pdfLabels } from './labels';
import { showOfficeSettings } from '../settings/dialog';
import { settingsLabels } from '../settings/labels';
import '../../genoffice/packages/ui/src/tokens.css';
import '../../genoffice/packages/ui/src/screentip.css';
import '../../genoffice/packages/ui/src/color-picker.css';
import '../../genoffice/packages/ui/src/dropdown.css';
import '../../genoffice/packages/ui/src/ribbon-collapse.css';
import '../../genoffice/packages/ui/src/markdown.css';
import '../../genoffice/packages/ui/src/ai-panel-prefs.css';
import '../../genoffice/apps/pdf/src/renderer/styles.css';
import '../ui/dialogs.css';
import './page.css';

let refresh = () => {};
const bridge = installPdfBridge(() => refresh());
function Page() {
  const { lang } = useI18n();
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState('');
  const [products, setProducts] = useState<PdfProducts>({ documents: [], downloads: [] });
  const [progress, setProgress] = useState<PdfProgress>(null);
  useEffect(() => bridge.onProducts(setProducts), []);
  useEffect(() => bridge.onProgress(setProgress), []);
  useEffect(() => {
    refresh = () => setGeneration((value) => value + 1);
    return () => { refresh = () => {}; };
  }, []);
  const text = pdfLabels(lang);
  const action = (run: () => Promise<unknown>) => { setError(''); void run().catch((error: unknown) => setError(error instanceof Error ? error.message : String(error))); };
  return <div className="matcha-pdf-page">
    <nav className="matcha-pdf-toolbar">
      <button type="button" onClick={() => action(bridge.openLibrary)}>{bridge.libraryLabel()}</button>
      <button type="button" onClick={() => action(bridge.importPdf)}>{text.import}</button>
      <button type="button" onClick={() => action(bridge.saveCopy)}>{text.copy}</button>
      <button type="button" onClick={() => action(showOfficeSettings)}>{settingsLabels().settings}</button>
      {error && <span role="alert">{error}</span>}
    </nav>
    {(products.documents.length > 0 || products.downloads.length > 0 || progress) && <section className="matcha-pdf-products" aria-live="polite">
      {progress && <span role="status">{text.converting}{progress.total > 0 ? ` ${progress.page}/${progress.total}` : '…'}</span>}
      {products.documents.length > 0 && <details open>
        <summary>{text.products} ({products.documents.length})</summary>
        <ul>{products.documents.map((product) => <li key={product.documentId}><button type="button" onClick={() => action(() => bridge.openProduct(product.documentId))}>{product.name}</button></li>)}</ul>
      </details>}
      {products.downloads.length > 0 && <details><summary>{text.downloads} ({products.downloads.length})</summary><ul>{products.downloads.map((name, index) => <li key={index}>{name}</li>)}</ul></details>}
    </section>}
    <App key={generation} />
  </div>;
}
async function start() {
  await bridge.bootstrap();
  const language = await window.pdfApi.getLanguage();
  document.documentElement.lang = htmlLang(language);
  document.documentElement.dir = htmlDir(language);
  applyAiPanelPrefs(await window.pdfApi.getAiPanelPrefs());
  installScreenTips();
  const root = document.getElementById('root');
  if (!root) throw new Error('PDF root element is missing.');
  createRoot(root).render(<LocaleProvider initial={language}><Page /></LocaleProvider>);
}
window.addEventListener('pagehide', () => bridge.dispose(), { once: true });
void start().catch((error: unknown) => {
  const root = document.getElementById('root');
  if (root) { root.setAttribute('role', 'alert'); root.textContent = error instanceof Error ? error.message : String(error); }
});
