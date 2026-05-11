import { SETTINGS_DEFAULTS } from './defaults';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';
import { normalizeBrowserMode } from '../../shared/browser-mode';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readSettingsStore(
  environment: OpenClawEnvironmentRepository,
  fileSystem: RuntimeFileSystemPort,
) {
  const filePath = environment.getRuntimeHostSettingsFilePath();
  try {
    const raw = await fileSystem.readTextFile(filePath);
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSettingsStore(
  environment: OpenClawEnvironmentRepository,
  fileSystem: RuntimeFileSystemPort,
  settings: Record<string, unknown>,
) {
  const filePath = environment.getRuntimeHostSettingsFilePath();
  await environment.ensureParentDir(filePath);
  await fileSystem.writeTextFile(filePath, `${JSON.stringify(settings, null, 2)}\n`);
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

function detectSystemLocale(environment: OpenClawEnvironmentRepository): string {
  const candidates = environment.getSystemLocaleCandidates();
  for (const candidate of candidates) {
    return candidate;
  }
  return 'en';
}

function createSettingsDefaults(environment: OpenClawEnvironmentRepository) {
  return {
    ...SETTINGS_DEFAULTS,
    language: resolveSupportedLanguage(detectSystemLocale(environment)),
  };
}

export class SettingsRepository {
  constructor(
    private readonly environment: OpenClawEnvironmentRepository,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  async getAll() {
    const raw = await readSettingsStore(this.environment, this.fileSystem);
    const settings = createSettingsDefaults(this.environment) as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      settings[key] = normalizeSettingsValueForKey(key, value);
    }
    settings.language = resolveSupportedLanguage(
      typeof settings.language === 'string' ? settings.language : undefined,
    );
    return settings;
  }

  async patch(patch: unknown) {
    const current = await this.getAll();
    for (const [key, value] of Object.entries(isRecord(patch) ? patch : {})) {
      current[key] = normalizeSettingsValueForKey(key, value);
    }
    await writeSettingsStore(this.environment, this.fileSystem, current);
    return current;
  }

  async setValue(key: string, value: unknown) {
    const patch: Record<string, unknown> = {};
    patch[key] = value;
    const next = await this.patch(patch);
    return next[key];
  }

  async reset() {
    const reset = createSettingsDefaults(this.environment);
    await writeSettingsStore(this.environment, this.fileSystem, reset);
    return reset;
  }
}
