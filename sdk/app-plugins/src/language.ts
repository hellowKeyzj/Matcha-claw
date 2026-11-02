export const SUPPORTED_LANGUAGE_CODES = ['en', 'zh', 'ja', 'ru'] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGE_CODES)[number];

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGE_CODES);

export function resolveSupportedLanguage(
  locale: string | null | undefined,
  fallback: SupportedLanguageCode = 'en',
): SupportedLanguageCode {
  const normalizedLocale = locale?.trim().toLowerCase().replaceAll('_', '-') ?? '';
  if (!normalizedLocale) return fallback;
  const [baseLanguage] = normalizedLocale.split('-');
  return SUPPORTED_LANGUAGE_SET.has(baseLanguage) ? baseLanguage as SupportedLanguageCode : fallback;
}
