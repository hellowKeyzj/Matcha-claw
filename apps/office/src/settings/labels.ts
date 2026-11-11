import { appApi } from '../documents/client';

const labels = {
  zh: {
    settings: 'Office 设置', documentTheme: '文档页面主题', follow: '跟随应用主题', light: '浅色', dark: '深色',
    autoSave: '所有文档自动保存', autoSaveHint: '默认开启各编辑器的自动保存，仍可在单个文档中关闭', on: '开启', off: '关闭',
    authorName: '作者姓名', authorHint: '用于批注和修订，留空则使用系统账户名',
    save: '保存设置', cancel: '取消', loadError: '无法加载 Office 设置，请稍后重试', saveError: '设置未能保存，请重试'
  },
  en: {
    settings: 'Office settings', documentTheme: 'Document page theme', follow: 'Follow app theme', light: 'Light', dark: 'Dark',
    autoSave: 'Auto-save all documents', autoSaveHint: 'Enable auto-save by default in every editor; you can still turn it off for individual documents', on: 'On', off: 'Off',
    authorName: 'Author name', authorHint: 'Used for comments and tracked changes; leave blank to use your system account name',
    save: 'Save settings', cancel: 'Cancel', loadError: 'Office settings could not be loaded. Try again later', saveError: 'Settings could not be saved. Try again'
  },
  ja: {
    settings: 'Office 設定', documentTheme: 'ドキュメントページのテーマ', follow: 'アプリのテーマに従う', light: 'ライト', dark: 'ダーク',
    autoSave: 'すべてのドキュメントを自動保存', autoSaveHint: '各エディターで自動保存を既定で有効にします。ドキュメントごとに無効にできます', on: 'オン', off: 'オフ',
    authorName: '作成者名', authorHint: 'コメントと変更履歴に使用します。空欄の場合はシステムのアカウント名を使用します',
    save: '設定を保存', cancel: 'キャンセル', loadError: 'Office 設定を読み込めませんでした。しばらくしてから再試行してください', saveError: '設定を保存できませんでした。再試行してください'
  },
  ru: {
    settings: 'Настройки Office', documentTheme: 'Тема страницы документа', follow: 'Как в приложении', light: 'Светлая', dark: 'Тёмная',
    autoSave: 'Автосохранение всех документов', autoSaveHint: 'Включать автосохранение по умолчанию во всех редакторах; его можно отключить для отдельного документа', on: 'Включено', off: 'Выключено',
    authorName: 'Имя автора', authorHint: 'Используется в комментариях и исправлениях; оставьте пустым для имени системной учётной записи',
    save: 'Сохранить настройки', cancel: 'Отмена', loadError: 'Не удалось загрузить настройки Office. Повторите попытку позже', saveError: 'Не удалось сохранить настройки. Повторите попытку'
  }
};

export function settingsLabels() {
  const language = appApi().context.language?.toLowerCase().split('-')[0] ?? 'en';
  return labels[language as keyof typeof labels] ?? labels.en;
}
