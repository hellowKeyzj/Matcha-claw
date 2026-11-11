const translations = {
  en: { open: 'Open Markdown or text', import: 'Import document', move: 'Move or rename', md: 'Download source', html: 'Export HTML', docx: 'Export Word', docs: 'Open in Docs', pdf: 'Export PDF', png: 'Export images', failed: 'Operation failed', downloadStarted: 'Download started' },
  zh: { open: '打开 Markdown 或文本', import: '导入文档', move: '移动或重命名', md: '下载原文', html: '导出 HTML', docx: '导出 Word', docs: '在 Docs 中打开', pdf: '导出 PDF', png: '导出图片', failed: '操作失败', downloadStarted: '已发起下载' },
  ja: { open: 'Markdown・テキストを開く', import: '文書をインポート', move: '移動または名前変更', md: 'ソースをダウンロード', html: 'HTML をエクスポート', docx: 'Word をエクスポート', docs: 'Docs で開く', pdf: 'PDF をエクスポート', png: '画像をエクスポート', failed: '操作に失敗しました', downloadStarted: 'ダウンロードを開始しました' },
  ko: { open: 'Markdown 또는 텍스트 열기', import: '문서 가져오기', move: '이동 또는 이름 변경', md: '원문 다운로드', html: 'HTML 내보내기', docx: 'Word 내보내기', docs: 'Docs에서 열기', pdf: 'PDF 내보내기', png: '이미지 내보내기', failed: '작업 실패', downloadStarted: '다운로드를 시작했습니다' },
  ru: { open: 'Открыть Markdown или текст', import: 'Импорт документа', move: 'Переместить или переименовать', md: 'Скачать исходный текст', html: 'Экспорт HTML', docx: 'Экспорт Word', docs: 'Открыть в Docs', pdf: 'Экспорт PDF', png: 'Экспорт изображений', failed: 'Операция не выполнена', downloadStarted: 'Загрузка начата' }
};
export function labels() {
  const language = document.documentElement.lang?.split('-')[0] ?? 'en';
  return translations[language as keyof typeof translations] ?? translations.en;
}
