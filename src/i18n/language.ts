export const SUPPORTED_LANGUAGE_CODES = ['en', 'zh', 'ja'] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGE_CODES)[number];

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGE_CODES);

function normalizeLocale(locale: string | null | undefined): string {
  return locale?.trim().toLowerCase().replaceAll('_', '-') ?? '';
}

export function resolveSupportedLanguage(
  locale: string | null | undefined,
  fallback: SupportedLanguageCode = 'en',
): SupportedLanguageCode {
  const normalizedLocale = normalizeLocale(locale);
  if (!normalizedLocale) {
    return fallback;
  }
  const [baseLanguage] = normalizedLocale.split('-');
  return SUPPORTED_LANGUAGE_SET.has(baseLanguage)
    ? (baseLanguage as SupportedLanguageCode)
    : fallback;
}
