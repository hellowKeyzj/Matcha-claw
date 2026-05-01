import { listInstalledClawHubSkills } from './clawhub';
import { readOpenClawConfigJson, writeOpenClawConfigJson } from '../../api/storage/paths';
import { withOpenClawConfigLock } from '../openclaw/openclaw-config-mutex';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type InstalledClawHubSkill = {
  slug: string;
  version?: string;
};

export function getAllSkillConfigsLocal() {
  const config = readOpenClawConfigJson();
  if (!isRecord(config.skills)) {
    return {};
  }
  const entries = config.skills.entries;
  if (!isRecord(entries)) {
    return {};
  }
  return entries;
}

export async function updateSkillConfigLocal(skillKey: string, updates: Record<string, unknown>) {
  const trimmedSkillKey = typeof skillKey === 'string' ? skillKey.trim() : '';
  if (!trimmedSkillKey) {
    return { success: false, error: 'skillKey is required' };
  }
  if (!isRecord(updates)) {
    return { success: false, error: 'updates is required' };
  }
  try {
    await withOpenClawConfigLock(async () => {
      const config = readOpenClawConfigJson();
      if (!isRecord(config.skills)) {
        config.skills = {};
      }
      if (!isRecord(config.skills.entries)) {
        config.skills.entries = {};
      }

      const entries = config.skills.entries;
      const current = isRecord(entries[trimmedSkillKey]) ? entries[trimmedSkillKey] : {};
      const entry = { ...current };

      if (Object.prototype.hasOwnProperty.call(updates, 'apiKey')) {
        if (typeof updates.apiKey !== 'string') {
          delete entry.apiKey;
        } else {
          const trimmed = updates.apiKey.trim();
          if (trimmed) {
            entry.apiKey = trimmed;
          } else {
            delete entry.apiKey;
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(updates, 'env')) {
        if (!isRecord(updates.env)) {
          delete entry.env;
        } else {
          const newEnv: Record<string, string> = {};
          for (const [key, value] of Object.entries(updates.env)) {
            const trimmedKey = key.trim();
            if (!trimmedKey) {
              continue;
            }
            const trimmedValue = typeof value === 'string' ? value.trim() : '';
            if (trimmedValue) {
              newEnv[trimmedKey] = trimmedValue;
            }
          }
          if (Object.keys(newEnv).length > 0) {
            entry.env = newEnv;
          } else {
            delete entry.env;
          }
        }
      }
      entries[trimmedSkillKey] = entry;
      await writeOpenClawConfigJson(config);
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function setSkillEnabledLocal(skillKey: string, enabled: boolean) {
  const trimmedSkillKey = typeof skillKey === 'string' ? skillKey.trim() : '';
  if (!trimmedSkillKey) {
    return { success: false, error: 'skillKey is required' };
  }
  try {
    await withOpenClawConfigLock(async () => {
      const config = readOpenClawConfigJson();
      if (!isRecord(config.skills)) {
        config.skills = {};
      }
      if (!isRecord(config.skills.entries)) {
        config.skills.entries = {};
      }

      const entries = config.skills.entries;
      const current = isRecord(entries[trimmedSkillKey]) ? entries[trimmedSkillKey] : {};
      entries[trimmedSkillKey] = {
        ...current,
        enabled,
      };
      await writeOpenClawConfigJson(config);
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function listEffectiveSkillsLocal() {
  const configs = getAllSkillConfigsLocal();
  const installed = await listInstalledClawHubSkills() as InstalledClawHubSkill[];
  const installedMap = new Map(installed.map((item) => [item.slug, item]));
  const keys = new Set([
    ...Object.keys(configs),
    ...installed.map((item) => item.slug),
  ]);

  const tools: Array<Record<string, unknown>> = [];
  for (const key of [...keys].sort()) {
    const configEntry = isRecord((configs as Record<string, unknown>)[key])
      ? (configs as Record<string, Record<string, unknown>>)[key]
      : {};
    const enabled = configEntry.enabled !== false;
    if (!enabled) {
      continue;
    }
    const installedEntry = installedMap.get(key);
    tools.push({
      id: key,
      slug: key,
      enabled: true,
      source: installedEntry ? 'clawhub' : 'config',
      ...(installedEntry ? { version: installedEntry.version } : {}),
    });
  }
  return tools;
}
