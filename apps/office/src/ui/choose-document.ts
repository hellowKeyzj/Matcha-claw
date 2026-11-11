import { appApi } from '../documents/client';
import type { DocumentRecord as AppDocumentRecord } from '../documents/model';

const labels = {
  zh: { docx: '打开文档', xlsx: '打开表格', pptx: '打开演示文稿', pdf: '打开 PDF', md: '打开 Markdown', html: '打开 HTML', txt: '打开文本', json: '打开 JSON', import: '导入文件', cancel: '取消' },
  en: { docx: 'Open document', xlsx: 'Open spreadsheet', pptx: 'Open presentation', pdf: 'Open PDF', md: 'Open Markdown', html: 'Open HTML', txt: 'Open text', json: 'Open JSON', import: 'Import a file', cancel: 'Cancel' },
  ja: { docx: '文書を開く', xlsx: '表計算を開く', pptx: 'プレゼンテーションを開く', pdf: 'PDF を開く', md: 'Markdown を開く', html: 'HTML を開く', txt: 'テキストを開く', json: 'JSON を開く', import: 'ファイルをインポート', cancel: 'キャンセル' },
  ru: { docx: 'Открыть документ', xlsx: 'Открыть таблицу', pptx: 'Открыть презентацию', pdf: 'Открыть PDF', md: 'Открыть Markdown', html: 'Открыть HTML', txt: 'Открыть текст', json: 'Открыть JSON', import: 'Импортировать файл', cancel: 'Отмена' },
  ko: { docx: '문서 열기', xlsx: '스프레드시트 열기', pptx: '프레젠테이션 열기', pdf: 'PDF 열기', md: 'Markdown 열기', html: 'HTML 열기', txt: '텍스트 열기', json: 'JSON 열기', import: '파일 가져오기', cancel: '취소' }
};

export function libraryLabels() {
  const language = appApi().context.language?.toLowerCase().split('-')[0] ?? 'en';
  return labels[language as keyof typeof labels] ?? labels.en;
}

export function chooseDocument<T extends Pick<AppDocumentRecord, 'id' | 'name'>>(
  documents: readonly T[], type: AppDocumentRecord['type'],
): Promise<T | 'import' | null> {
  const text = libraryLabels();
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'matcha-library-dialog';
  const title = document.createElement('h2');
  title.textContent = text[type === 'csv' ? 'xlsx' : type];
  title.id = 'matcha-library-title';
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.append(title);

  return new Promise((resolve) => {
    let selected: T | 'import' | null = null;
    const addButton = (label: string, value: typeof selected) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.onclick = () => { selected = value; dialog.close(); };
      dialog.append(button);
    };
    for (const entry of documents) addButton(entry.name, entry);
    addButton(text.import, 'import');
    addButton(text.cancel, null);
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(selected);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
