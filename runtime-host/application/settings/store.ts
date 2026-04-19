import { SETTINGS_DEFAULTS } from '../../api/settings-defaults';
import { ensureParentDir, getRuntimeHostSettingsFilePath } from '../../api/storage/paths';
import { promises as fsPromises } from 'node:fs';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readSettingsStore() {
  const filePath = getRuntimeHostSettingsFilePath();
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSettingsStore(settings: Record<string, unknown>) {
  const filePath = getRuntimeHostSettingsFilePath();
  await ensureParentDir(filePath);
  await fsPromises.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function normalizeBrowserMode(value: unknown): 'off' | 'relay' | 'native' {
  if (value === 'off' || value === 'native') {
    return value;
  }
  return 'relay';
}

function normalizeSettingsValueForKey(key: string, value: unknown) {
  const defaultValue = (SETTINGS_DEFAULTS as Record<string, any>)[key];
  if (defaultValue === undefined) {
    return value;
  }
  if (key === 'browserMode') {
    return normalizeBrowserMode(value);
  }
  if (typeof defaultValue === 'boolean') {
    return value === true;
  }
  if (typeof defaultValue === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : defaultValue;
  }
  if (typeof defaultValue === 'string') {
    return typeof value === 'string' ? value : defaultValue;
  }
  if (defaultValue === null) {
    return value == null || typeof value === 'string' ? value : null;
  }
  if (Array.isArray(defaultValue)) {
    return Array.isArray(value) ? value : [...defaultValue];
  }
  if (isRecord(defaultValue)) {
    return isRecord(value) ? value : { ...defaultValue };
  }
  return value;
}

const SUPPORTED_LANGUAGE_CODES = new Set(['en', 'zh', 'ja']);

function resolveSupportedLanguage(locale: string | null | undefined, fallback = 'en'): string {
  const normalized = locale?.trim().toLowerCase().replaceAll('_', '-') ?? '';
  if (!normalized) {
    return fallback;
  }
  const [baseLanguage] = normalized.split('-');
  return SUPPORTED_LANGUAGE_CODES.has(baseLanguage) ? baseLanguage : fallback;
}

function detectSystemLocale(): string {
  const candidates = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return 'en';
}

function createSettingsDefaults() {
  return {
    ...SETTINGS_DEFAULTS,
    language: resolveSupportedLanguage(detectSystemLocale()),
  };
}

export async function getAllSettingsLocal() {
  const raw = await readSettingsStore();
  const settings = createSettingsDefaults() as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    settings[key] = normalizeSettingsValueForKey(key, value);
  }
  settings.language = resolveSupportedLanguage(
    typeof settings.language === 'string' ? settings.language : undefined,
  );
  return settings;
}

export async function setSettingsPatchLocal(patch: unknown) {
  const current = await getAllSettingsLocal();
  for (const [key, value] of Object.entries(isRecord(patch) ? patch : {})) {
    current[key] = normalizeSettingsValueForKey(key, value);
  }
  await writeSettingsStore(current);
  return current;
}

export async function setSettingValueLocal(key: string, value: unknown) {
  const patch: Record<string, unknown> = {};
  patch[key] = value;
  const next = await setSettingsPatchLocal(patch);
  return next[key];
}

export async function resetSettingsLocal() {
  const reset = createSettingsDefaults();
  await writeSettingsStore(reset);
  return reset;
}
