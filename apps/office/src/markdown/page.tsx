import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import App from '../../genoffice/apps/markdown/src/renderer/App';
import { LocaleProvider } from '../../genoffice/apps/markdown/src/renderer/i18n/locale';
import { htmlDir, htmlLang } from '../../genoffice/packages/i18n/src';
import { installScreenTips } from '../../genoffice/packages/ui/src';
import { installMarkdownBridge } from './bridge';
import { labels } from './labels';
import { showOfficeSettings } from '../settings/dialog';
import { settingsLabels } from '../settings/labels';
import '../../genoffice/packages/ui/src/tokens.css';
import '../../genoffice/packages/ui/src/screentip.css';
import '../../genoffice/packages/ui/src/dropdown.css';
import '../../genoffice/packages/ui/src/find-panel.css';
import '../../genoffice/packages/ui/src/ribbon-collapse.css';
import '../../genoffice/packages/ui/src/markdown.css';
import '../../genoffice/packages/ui/src/image-viewer.css';
import 'katex/dist/katex.min.css';
import '../../genoffice/apps/markdown/src/renderer/styles.css';
import '../../genoffice/apps/markdown/src/renderer/markdown-themes.css';
import '../ui/dialogs.css';
import './page.css';

async function start() {
  const root = document.getElementById('root');
  if (!root) throw new Error('Markdown root element is missing.');
  let remount = () => {};
  const bridge = await installMarkdownBridge(() => remount());
  document.documentElement.lang = htmlLang(bridge.language);
  document.documentElement.dir = htmlDir(bridge.language);
  const applyDocumentTheme = (theme: Awaited<ReturnType<typeof window.markdownApi.getDocumentTheme>>) => {
    if (theme === 'follow') document.documentElement.removeAttribute('data-doc-theme');
    else document.documentElement.dataset.docTheme = theme;
  };
  applyDocumentTheme(await window.markdownApi.getDocumentTheme());
  const stopDocumentTheme = window.markdownApi.onDocumentThemeChanged(applyDocumentTheme);
  window.addEventListener('pagehide', stopDocumentTheme, { once: true });
  installScreenTips();
  function Page() {
    const [generation, setGeneration] = useState(0);
    const [error, setError] = useState('');
    const [, setLanguage] = useState(bridge.language);
    useEffect(() => window.markdownApi.onLanguageChanged(setLanguage), []);
    useEffect(() => {
      const refresh = () => setGeneration((value) => value + 1);
      remount = refresh;
      return () => { if (remount === refresh) remount = () => {}; };
    }, []);
    const text = labels();
    const run = (operation: () => Promise<unknown>) => { setError(''); void operation().catch((error) => setError(error instanceof Error ? error.message : String(error))); };
    useEffect(() => {
      const openKey = (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'o') return;
        event.preventDefault();
        run(() => bridge.importFile());
      };
      const drop = (event: DragEvent) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        const notes = files.filter(file => /\.(md|markdown|txt|json|zip)$/i.test(file.name)).slice(0, 20);
        if (!notes.length) return;
        event.preventDefault(); event.stopPropagation();
        run(async () => { for (const note of notes) await bridge.importFile([note, ...files.filter(file => file !== note && !/\.(md|markdown|txt|json|zip)$/i.test(file.name))]); });
      };
      const dragOver = (event: DragEvent) => { if ([...(event.dataTransfer?.types ?? [])].includes('Files')) event.preventDefault(); };
      window.addEventListener('keydown', openKey, true);
      document.addEventListener('dragover', dragOver);
      document.addEventListener('drop', drop, true);
      return () => { window.removeEventListener('keydown', openKey, true); document.removeEventListener('dragover', dragOver); document.removeEventListener('drop', drop, true); };
    }, []);
    return <LocaleProvider initial={bridge.language}>
      <div className="matcha-markdown-page">
        <nav className="matcha-markdown-toolbar" aria-label={text.open}>
          <button type="button" onClick={() => run(bridge.openLibrary)}>{text.open}</button>
          <button type="button" onClick={() => run(bridge.importFile)}>{text.import}</button>
          <button type="button" onClick={() => run(bridge.move)}>{text.move}</button>
          {(['md', 'html', 'docx', 'docs', 'pdf', 'png'] as const).map((format) => <button type="button" key={format} onClick={() => run(() => bridge.export(format))}>{text[format]}</button>)}
          <button type="button" onClick={() => run(showOfficeSettings)}>{settingsLabels().settings}</button>
        </nav>
        {error && <div className="matcha-markdown-error" role="alert">{text.failed}: {error}</div>}
        <App key={generation} />
      </div>
    </LocaleProvider>;
  }
  createRoot(root).render(<Page />);
}
void start();
