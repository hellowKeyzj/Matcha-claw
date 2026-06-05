import { SETTINGS_DEFAULTS } from '../../settings/defaults';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import { normalizeBrowserMode } from '../../../shared/browser-mode';

export interface SettingsStoreEnvironmentPort {
  getRuntimeHostSettingsFilePath(): string;
  getSystemLocaleCandidates(): readonly string[];
  ensureParentDir(filePath: string): Promise<void>;
}

export interface SettingsStoreWorkflowDeps {
  readonly environment: SettingsStoreEnvironmentPort;
  readonly fileSystem: RuntimeFileSystemPort;
}

export class SettingsStoreWorkflow {
  constructor(private readonly deps: SettingsStoreWorkflowDeps) {}

  async getAll() {
    const raw = await this.readSettingsStore();
    const settings = this.createSettingsDefaults() as Record<string, unknown>;
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
    await this.writeSettingsStore(current);
    return current;
  }

  async setValue(key: string, value: unknown) {
    const patch: Record<string, unknown> = {};
    patch[key] = value;
    const next = await this.patch(patch);
    return next[key];
  }

  async reset() {
    const reset = this.createSettingsDefaults();
    await this.writeSettingsStore(reset);
    return reset;
  }

  private async readSettingsStore() {
    const filePath = this.deps.environment.getRuntimeHostSettingsFilePath();
    try {
      const raw = await this.deps.fileSystem.readTextFile(filePath);
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private async writeSettingsStore(settings: Record<string, unknown>) {
    const filePath = this.deps.environment.getRuntimeHostSettingsFilePath();
    await this.deps.environment.ensureParentDir(filePath);
    await this.deps.fileSystem.writeTextFile(filePath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  private createSettingsDefaults() {
    return {
      ...SETTINGS_DEFAULTS,
      language: resolveSupportedLanguage(detectSystemLocale(this.deps.environment)),
    };
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function detectSystemLocale(environment: SettingsStoreEnvironmentPort): string {
  const candidates = environment.getSystemLocaleCandidates();
  for (const candidate of candidates) {
    return candidate;
  }
  return 'en';
}
