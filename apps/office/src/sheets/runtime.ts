import type { AppPluginContext } from '@matcha/app-plugins-sdk';
import { join } from 'node:path';
import { normalizeLang } from '@genoffice/i18n';
import type { SheetsRuntimeConfig } from './sheets-main';

let configuration: SheetsRuntimeConfig | undefined;

/** Activate before registering tools: headless imports use the same OS region. */
export async function initializeSheetsRuntime(context: AppPluginContext): Promise<void> {
  const { locale } = await context.desktop.systemLocale({});
  const native = await import('@matcha/sheets-main');
  configuration = {
    preloadPath: join(context.packagePath, 'sheets.html'),
    rendererFile: join(context.packagePath, 'sheets.html'),
    sidecarPath: process.env.XLSX_SIDECAR_PATH,
    systemLocale: locale,
    uiLanguage: normalizeLang(locale)
  };
  native.configureSheetsRuntime(configuration);
}

export function sheetsCsvCharset(): string | undefined {
  const language = configuration?.uiLanguage;
  return language === 'zh' ? 'gb18030' : language === 'zh-TW' ? 'big5' : language === 'ja' ? 'shift_jis' : language === 'ko' ? 'euc-kr' : undefined;
}

export async function sheetsRuntime(language?: string) {
  if (!configuration) throw new Error('Sheets runtime must be initialized before tools are registered.');
  const native = await import('@matcha/sheets-main');
  if (language !== undefined) {
    configuration = { ...configuration, uiLanguage: normalizeLang(language) };
    native.configureSheetsRuntime(configuration);
  }
  return native;
}
