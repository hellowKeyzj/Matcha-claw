const dialog = {
  en: { yes: 'Yes', no: 'No', clipboardError: 'Clipboard access failed. Keep this document focused and try again.' },
  zh: { yes: '是', no: '否', clipboardError: '剪贴板访问失败。请保持文档焦点后重试。' },
  ja: { yes: 'はい', no: 'いいえ', clipboardError: 'クリップボードにアクセスできません。文書にフォーカスして再試行してください。' },
  ru: { yes: 'Да', no: 'Нет', clipboardError: 'Не удалось получить доступ к буферу обмена. Верните фокус документу и повторите попытку.' }
};

export function docsDialogLabels() {
  const language = window.matchaApp?.context.language?.split('-')[0] ?? 'en';
  return dialog[language as keyof typeof dialog] ?? dialog.en;
}

const recovery = {
  en: { title: 'Recovered version found', body: 'A recovery copy contains changes that were not saved. Restore it?', newer: 'The library document was updated after this copy. Saving the restored copy may conflict with newer changes.', restore: 'Restore', discard: 'Discard recovery copy' },
  zh: { title: '发现恢复副本', body: '恢复副本中有尚未保存的修改，是否恢复？', newer: '文库文档在此副本之后有更新，保存恢复内容时可能与较新的修改冲突。', restore: '恢复', discard: '丢弃恢复副本' },
  ja: { title: '復元用コピーが見つかりました', body: '復元用コピーに未保存の変更があります。復元しますか？', newer: 'このコピーの作成後にライブラリの文書が更新されています。復元した内容の保存時に競合する場合があります。', restore: '復元', discard: '復元用コピーを破棄' },
  ru: { title: 'Найдена копия для восстановления', body: 'Копия содержит несохранённые изменения. Восстановить их?', newer: 'Документ в библиотеке обновлён после создания копии. При сохранении восстановленной версии возможен конфликт.', restore: 'Восстановить', discard: 'Удалить копию восстановления' }
};

const legacyImport = {
  en: { title: 'Import as a Word document', body: 'A new .docx copy will be created. Some features may not be preserved; the original file is unchanged.', convert: 'Import copy', remember: 'Import copy and don’t ask again for this format', detail: 'Import details', done: 'Continue' },
  zh: { title: '导入为 Word 文档', body: '将创建新的 .docx 副本。部分功能可能无法保留，原文件不会改变。', convert: '导入副本', remember: '导入副本，此格式不再询问', detail: '导入详情', done: '继续' },
  ja: { title: 'Word 文書としてインポート', body: '新しい .docx コピーを作成します。一部の機能は保持されない場合があります。元のファイルは変更されません。', convert: 'コピーをインポート', remember: 'コピーをインポートし、この形式では今後確認しない', detail: 'インポートの詳細', done: '続行' },
  ru: { title: 'Импорт в документ Word', body: 'Будет создана новая копия .docx. Некоторые функции могут не сохраниться. Исходный файл не изменится.', convert: 'Импортировать копию', remember: 'Импортировать и больше не спрашивать для этого формата', detail: 'Сведения об импорте', done: 'Продолжить' }
};

export function docsImportLabels() {
  const language = window.matchaApp?.context.language?.split('-')[0] ?? 'en';
  return legacyImport[language as keyof typeof legacyImport] ?? legacyImport.en;
}

const conflict = {
  en: { title: 'The document changed in the library', body: 'Your changes have not been saved. Overwrite the current library version, or save a copy to keep both versions?', overwrite: 'Overwrite', changedAgain: 'The library document changed again while you were deciding. Nothing was overwritten. Save a copy to keep your changes.', copy: 'Save a copy' },
  zh: { title: '文库中的文档已更新', body: '你的修改尚未保存。覆盖当前文库版本，还是保存副本以保留两个版本？', overwrite: '覆盖', changedAgain: '确认期间文库文档再次更新，本次未覆盖。可保存副本保留你的修改。', copy: '保存副本' },
  ja: { title: 'ライブラリの文書が更新されました', body: '変更はまだ保存されていません。現在の版を上書きするか、コピーを保存して両方の版を残しますか？', overwrite: '上書き', changedAgain: '確認中に文書が再度更新されました。上書きしていません。変更を残すにはコピーを保存してください。', copy: 'コピーを保存' },
  ru: { title: 'Документ в библиотеке изменён', body: 'Изменения не сохранены. Перезаписать текущую версию или сохранить копию, чтобы оставить обе?', overwrite: 'Перезаписать', changedAgain: 'Пока вы выбирали, документ изменился снова. Ничего не перезаписано. Сохраните копию, чтобы не потерять изменения.', copy: 'Сохранить копию' }
};

export function docsConflictLabels() {
  const language = window.matchaApp?.context.language?.split('-')[0] ?? 'en';
  return conflict[language as keyof typeof conflict] ?? conflict.en;
}

export function docsRecoveryLabels() {
  const language = window.matchaApp?.context.language?.split('-')[0] ?? 'en';
  return recovery[language as keyof typeof recovery] ?? recovery.en;
}
