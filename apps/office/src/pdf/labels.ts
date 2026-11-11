import type { Lang } from '../../genoffice/packages/i18n/src';

const labels = {
  en: { copy: 'Save a copy', import: 'Import PDF', products: 'Saved to library', downloads: 'Downloads initiated', converting: 'Converting', warnings: 'Conversion warnings', ocr: 'OCR recovered editable text; proofread pages:', images: 'Pages exported as images:', missing: 'Markdown cannot include the image fallback; missing pages:', ok: 'OK', saveFailed: 'PDF save was canceled or failed.', invalidFormat: 'Unsupported conversion format.' },
  zh: { copy: '保存副本', import: '导入 PDF', products: '已存入文库', downloads: '已发起下载', converting: '正在转换', warnings: '转换提示', ocr: '以下页面已由 OCR 恢复为可编辑文字，请校对：', images: '以下页面已作为图片导出：', missing: 'Markdown 无法包含备用整页图片，以下页面内容缺失：', ok: '确定', saveFailed: 'PDF 保存已取消或失败', invalidFormat: '不支持此转换格式' },
  ja: { copy: 'コピーを保存', import: 'PDF をインポート', products: 'ライブラリに保存済み', downloads: 'ダウンロードを開始しました', converting: '変換中', warnings: '変換に関する注意', ocr: 'OCR で編集可能なテキストを復元しました。次のページを確認してください：', images: '画像として出力されたページ：', missing: 'Markdown に代替のページ画像を含められません。欠落したページ：', ok: 'OK', saveFailed: 'PDF の保存がキャンセルされたか失敗しました。', invalidFormat: '未対応の変換形式です。' },
  ru: { copy: 'Сохранить копию', import: 'Импорт PDF', products: 'Сохранено в библиотеке', downloads: 'Загрузки запущены', converting: 'Преобразование', warnings: 'Предупреждения преобразования', ocr: 'OCR восстановил редактируемый текст. Проверьте страницы:', images: 'Страницы экспортированы как изображения:', missing: 'Markdown не включает резервные изображения. Пропущенные страницы:', ok: 'ОК', saveFailed: 'Сохранение PDF отменено или завершилось ошибкой.', invalidFormat: 'Неподдерживаемый формат преобразования.' },
  ko: { copy: '사본 저장', import: 'PDF 가져오기', products: '라이브러리에 저장됨', downloads: '다운로드 시작됨', converting: '변환 중', warnings: '변환 알림', ocr: 'OCR로 편집 가능한 텍스트를 복원했습니다. 다음 페이지를 교정하세요:', images: '이미지로 내보낸 페이지:', missing: 'Markdown에 대체 페이지 이미지를 포함할 수 없습니다. 누락된 페이지:', ok: '확인', saveFailed: 'PDF 저장이 취소되었거나 실패했습니다.', invalidFormat: '지원하지 않는 변환 형식입니다.' }
};

export function pdfLabels(language: Lang) { return labels[language as keyof typeof labels] ?? labels.en; }
