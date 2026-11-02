const WORDS = {
  more: ['More options', '更多选项', 'その他のオプション', 'Другие действия'],
  find: ['Find in page', '在页面中查找', 'ページ内を検索', 'Найти на странице'],
  zoom: ['Zoom', '缩放', 'ズーム', 'Масштаб'],
  zoomIn: ['Zoom in', '放大', '拡大', 'Увеличить'],
  zoomOut: ['Zoom out', '缩小', '縮小', 'Уменьшить'],
  resetZoom: ['Reset zoom', '重置缩放', 'ズームをリセット', 'Сбросить масштаб'],
  screenshot: ['Take screenshot', '截取页面', 'スクリーンショットを撮影', 'Сделать снимок экрана'],
  clearData: ['Clear browsing data', '清除浏览数据', '閲覧データを消去', 'Очистить данные браузера'],
  clearCache: ['Clear cache', '清除缓存', 'キャッシュを消去', 'Очистить кеш'],
  clearSiteData: ['Clear shared cookies and site storage', '清除共享 Cookie 和网站存储', '共有 Cookie とサイトデータを消去', 'Очистить общие cookie и данные сайтов'],
  downloads: ['Downloads', '下载', 'ダウンロード', 'Загрузки'],
  history: ['History', '历史记录', '履歴', 'История'],
  openExternal: ['Open in default browser', '在默认浏览器中打开', '既定のブラウザーで開く', 'Открыть в браузере по умолчанию'],
  removeSuggestion: ['Delete this site from history', '从历史记录中删除此网站', 'このサイトを履歴から削除', 'Удалить этот сайт из истории'],
  completed: ['Download complete', '下载完成', 'ダウンロード完了', 'Загрузка завершена'],
  open: ['Open', '打开', '開く', 'Открыть'],
  showInFolder: ['Show in folder', '在文件夹中显示', 'フォルダーに表示', 'Показать в папке'],
  close: ['Close', '关闭', '閉じる', 'Закрыть'],
  failed: ['Action failed. Try again.', '操作失败，请重试。', '操作に失敗しました。もう一度お試しください。', 'Не удалось выполнить действие. Повторите попытку.'],
  empty: ['No downloads yet', '暂无下载', 'ダウンロードはありません', 'Загрузок пока нет'],
  openDirectory: ['Open downloads folder', '打开下载文件夹', 'ダウンロードフォルダーを開く', 'Открыть папку загрузок'],
  remove: ['Remove from list', '从列表中移除', '一覧から削除', 'Убрать из списка'],
  pause: ['Pause', '暂停', '一時停止', 'Приостановить'],
  resume: ['Resume', '继续下载', '再開', 'Возобновить'],
  cancel: ['Cancel', '取消', 'キャンセル', 'Отменить'],
  progressing: ['Downloading', '正在下载', 'ダウンロード中', 'Загрузка'],
  paused: ['Paused', '已暂停', '一時停止中', 'Приостановлено'],
  downloaded: ['Completed', '已完成', '完了', 'Завершено'],
  cancelled: ['Cancelled', '已取消', 'キャンセル済み', 'Отменено'],
  interrupted: ['Interrupted', '已中断', '中断', 'Прервано'],
  missing: ['File missing', '文件已不存在', 'ファイルが見つかりません', 'Файл не найден'],
  missingDescription: ['This file was moved or deleted.', '此文件已被移动或删除。', 'このファイルは移動または削除されました。', 'Этот файл перемещён или удалён.'],
};

export type Labels = { [Key in keyof typeof WORDS]: string };

export function labelsFor(locale: string): Labels {
  const column = ({ en: 0, zh: 1, ja: 2, ru: 3 } as Record<string, number>)[locale.split(/[-_]/)[0]] ?? 0;
  return Object.fromEntries(Object.entries(WORDS).map(([key, values]) => [key, values[column]])) as Labels;
}
