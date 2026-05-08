import { describe, expect, it } from 'vitest';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';

describe('russian i18n resources', () => {
  it('registers Russian as a supported language', () => {
    expect(SUPPORTED_LANGUAGES.some((language) => language.code === 'ru')).toBe(true);
  });

  it('loads Russian translations for core namespaces', async () => {
    await i18n.changeLanguage('ru');

    expect(i18n.t('common:sidebar.chat')).toBe('Чат');
    expect(i18n.t('settings:title')).toBe('Настройки');
    expect(i18n.t('setup:welcome.title')).toBe('Добро пожаловать в MatchaClaw');
  });
});
