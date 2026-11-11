import '../platform/browser-storage';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@matcha/html-app';
import { LocaleProvider, useI18n } from '../../genoffice/apps/html/src/renderer/i18n/locale';
import { htmlDir, htmlLang } from '../../genoffice/packages/i18n/src';
import { installScreenTips } from '../../genoffice/packages/ui/src';
import '../../genoffice/packages/ui/src/tokens.css';
import '../../genoffice/packages/ui/src/screentip.css';
import '../../genoffice/packages/ui/src/dropdown.css';
import '../../genoffice/packages/ui/src/find-panel.css';
import '../../genoffice/packages/ui/src/color-picker.css';
import '../../genoffice/packages/ui/src/ribbon-collapse.css';
import '../../genoffice/packages/ui/src/image-dialogs.css';
import '../../genoffice/apps/html/src/renderer/styles.css';
import { installHtmlBridge } from './bridge';
import { showOfficeSettings } from '../settings/dialog';
import { settingsLabels } from '../settings/labels';
import '../ui/dialogs.css';
import './page.css';

const labels = {
  zh: { open: '打开 HTML', new: '新建', folder: '导入网页文件夹', html: '导出 HTML（含资源时为 ZIP）', word: '导出 Word', pdf: '导出 PDF', image: '导出图片' },
  en: { open: 'Open HTML', new: 'New', folder: 'Import webpage folder', html: 'Export HTML (ZIP with resources)', word: 'Export Word', pdf: 'Export PDF', image: 'Export image' },
  ja: { open: 'HTML を開く', new: '新規', folder: 'Web ページフォルダーをインポート', html: 'HTML をエクスポート（リソース付きは ZIP）', word: 'Word をエクスポート', pdf: 'PDF をエクスポート', image: '画像をエクスポート' },
  ru: { open: 'Открыть HTML', new: 'Создать', folder: 'Импорт папки веб-страницы', html: 'Экспорт HTML (с ресурсами — ZIP)', word: 'Экспорт Word', pdf: 'Экспорт PDF', image: 'Экспорт изображения' },
  ko: { open: 'HTML 열기', new: '새로 만들기', folder: '웹페이지 폴더 가져오기', html: 'HTML 내보내기(리소스 포함 시 ZIP)', word: 'Word 내보내기', pdf: 'PDF 내보내기', image: '이미지 내보내기' }
};
const singleFileLabels = { zh: '导出单文件 HTML', en: 'Export single-file HTML', ja: '単一 HTML ファイルをエクスポート', ru: 'Экспорт одного HTML-файла', ko: '단일 HTML 파일 내보내기' };
const bridge = installHtmlBridge();
const registerDocumentAction = (handler: (action: string, input: Record<string, unknown>) => Promise<unknown>) => bridge.onAction(request => { void handler(request.action, request.input).then(request.resolve, request.reject); });
function Page() {
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { lang: language, t } = useI18n();
  useEffect(() => {
    const stop = bridge.onOpened(() => setGeneration(value => value + 1));
    bridge.ready();
    return stop;
  }, []);
  const text = labels[language as keyof typeof labels] ?? labels.en;
  const run = (operation: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true); setError('');
    void operation().then((changed) => { if (changed) setGeneration((value) => value + 1); })
      .catch((reason) => setError(String(reason))).finally(() => setBusy(false));
  };
  return <div className="matcha-html-page">
    <div className="matcha-html-files">
      <button type="button" disabled={busy} onClick={() => run(bridge.open)}>{text.open}</button>
      <button type="button" disabled={busy} onClick={() => run(bridge.newDocument)}>{text.new}</button>
      <button type="button" disabled={busy} onClick={() => run(bridge.importFolder)}>{text.folder}</button>
      <button type="button" disabled={busy} onClick={() => bridge.export('html')}>{text.html}</button>
      <button type="button" disabled={busy} onClick={() => run(async () => {
        const result = await bridge.exportSingleFile();
        if (result.skipped.length) setError(t('exportHtmlSkipped', { count: result.skipped.length, first: result.skipped[0] }));
        return false;
      })}>{singleFileLabels[language as keyof typeof singleFileLabels] ?? singleFileLabels.en}</button>
      <button type="button" disabled={busy} onClick={() => bridge.export('docx')}>{text.word}</button>
      <button type="button" disabled={busy} onClick={() => bridge.export('pdf')}>{text.pdf}</button>
      <button type="button" disabled={busy} onClick={() => run(bridge.exportImage)}>{text.image}</button>
      <button type="button" disabled={busy} onClick={() => run(async () => { await showOfficeSettings(); return false; })}>{settingsLabels().settings}</button>
      {error && <span role="alert">{error}</span>}
    </div>
    <App key={generation} onOpenExternal={bridge.openExternal} onDocumentAction={registerDocumentAction} />
  </div>;
}
async function start() {
  await bridge.initialize();
  const lang = await bridge.api.getLanguage();
  document.documentElement.lang = htmlLang(lang);
  document.documentElement.dir = htmlDir(lang);
  installScreenTips();
  const root = document.getElementById('root');
  if (!root) throw new Error('HTML root element is missing.');
  createRoot(root).render(<LocaleProvider initial={lang}><Page /></LocaleProvider>);
}
void start();
