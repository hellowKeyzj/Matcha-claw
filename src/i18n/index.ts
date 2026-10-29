import i18n, { type Resource, type ResourceKey } from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
    SUPPORTED_LANGUAGE_CODES,
    resolveSupportedLanguage,
    type SupportedLanguageCode,
} from './language';

export const SUPPORTED_LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'zh', label: '中文' },
    { code: 'ja', label: '日本語' },
    { code: 'ru', label: 'Русский' },
] as const satisfies ReadonlyArray<{ code: SupportedLanguageCode; label: string }>;

export type LanguageCode = SupportedLanguageCode;

const localeResources = import.meta.glob<ResourceKey>([
    './locales/*/*.json',
    '../plugins/*/locales/*/*.json',
], { eager: true, import: 'default' });

const resources: Resource = {};
for (const [path, translations] of Object.entries(localeResources)) {
    const [language, fileName] = path.split('/').slice(-2);
    const name = fileName.slice(0, -'.json'.length);
    const namespace = name === 'subagent-templates' ? 'subagentTemplates' : name;
    (resources[language] ??= {})[namespace] = translations;
}

i18n
    .use(initReactI18next)
    .init({
        resources,
        lng: resolveSupportedLanguage(typeof navigator !== 'undefined' ? navigator.language : undefined),
        fallbackLng: 'en',
        supportedLngs: [...SUPPORTED_LANGUAGE_CODES],
        defaultNS: 'common',
        ns: Object.keys(resources.en),
        interpolation: {
            escapeValue: false, // React already escapes
        },
        react: {
            useSuspense: false,
        },
    });

export default i18n;
