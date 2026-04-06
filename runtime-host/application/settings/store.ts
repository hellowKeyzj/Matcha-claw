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

function normalizeSettingsValueForKey(key: string, value: unknown) {
  const defaultValue = (SETTINGS_DEFAULTS as Record<string, any>)[key];
  if (defaultValue === undefined) {
    return value;
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

export async function getAllSettingsLocal() {
  const raw = await readSettingsStore();
  const settings = { ...SETTINGS_DEFAULTS } as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    settings[key] = normalizeSettingsValueForKey(key, value);
  }
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
  const reset = { ...SETTINGS_DEFAULTS };
  await writeSettingsStore(reset);
  return reset;
}
