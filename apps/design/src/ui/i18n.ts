import { createInstance } from 'i18next';
import { initReactI18next, useTranslation as useReactTranslation } from 'react-i18next';
import type { AppWebviewApi } from '../../../../src/types/desktop/app-plugin-sdk';
import { resolveSupportedLanguage, SUPPORTED_LANGUAGE_CODES } from '../../../../src/i18n/language';
import zh from './locales/zh.json';
import en from './locales/en.json';
import ja from './locales/ja.json';
import ru from './locales/ru.json';

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources: { zh: { translation: zh }, en: { translation: en }, ja: { translation: ja }, ru: { translation: ru } },
  lng: resolveSupportedLanguage(navigator.language),
  fallbackLng: 'en',
  supportedLngs: [...SUPPORTED_LANGUAGE_CODES],
  initImmediate: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
  react: { useSuspense: false },
});
document.documentElement.lang = i18n.resolvedLanguage ?? i18n.language;

export function t(key: string, values?: Record<string, string | number>): string {
  return i18n.t(key, values);
}

export function useTranslation(): { t: typeof t } {
  useReactTranslation(undefined, { i18n });
  return { t };
}

export function setLanguage(language: string): void {
  const resolved = resolveSupportedLanguage(language);
  void i18n.changeLanguage(resolved);
  document.documentElement.lang = resolved;
}

export function startLocaleSync(api: AppWebviewApi): () => void {
  if (api.context.language) setLanguage(api.context.language);
  return api.subscribe(({ topic, data }) => {
    if (topic === 'locale.changed' && data && typeof data === 'object' && !Array.isArray(data) && typeof data.language === 'string') setLanguage(data.language);
  });
}

export default i18n;
