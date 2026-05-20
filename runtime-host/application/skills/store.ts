import type { ClawHubSkillInventory } from './clawhub';
import { withOpenClawConfigLock } from '../openclaw/openclaw-config-mutex';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import type { OpenClawWorkspacePort } from '../openclaw/openclaw-workspace-service';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import { applicationResponse, badRequest, notFound, ok, serverError } from '../common/application-response';
import path from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type InstalledClawHubSkill = {
  slug: string;
  version?: string;
};

export class SkillsConfigRepository {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly clawHubSkillInventory: Pick<ClawHubSkillInventory, 'listInstalled'>,
  ) {}

  async getAllConfigs() {
    const config = await this.configRepository.read();
    if (!isRecord(config.skills)) {
      return {};
    }
    const entries = config.skills.entries;
    if (!isRecord(entries)) {
      return {};
    }
    return entries;
  }

  async updateConfig(skillKey: string, updates: Record<string, unknown>) {
    const trimmedSkillKey = typeof skillKey === 'string' ? skillKey.trim() : '';
    if (!trimmedSkillKey) {
      return { success: false, error: 'skillKey is required' };
    }
    if (!isRecord(updates)) {
      return { success: false, error: 'updates is required' };
    }
    try {
      await withOpenClawConfigLock(async () => {
        const config = await this.configRepository.read();
        if (!isRecord(config.skills)) {
          config.skills = {};
        }
        const skills = config.skills as Record<string, unknown>;
        if (!isRecord(skills.entries)) {
          skills.entries = {};
        }

        const entries = skills.entries as Record<string, unknown>;
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
        await this.configRepository.write(config);
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async setEnabled(skillKey: string, enabled: boolean) {
    const trimmedSkillKey = typeof skillKey === 'string' ? skillKey.trim() : '';
    if (!trimmedSkillKey) {
      return { success: false, error: 'skillKey is required' };
    }
    try {
      await withOpenClawConfigLock(async () => {
        const config = await this.configRepository.read();
        if (!isRecord(config.skills)) {
          config.skills = {};
        }
        const skills = config.skills as Record<string, unknown>;
        if (!isRecord(skills.entries)) {
          skills.entries = {};
        }

        const entries = skills.entries as Record<string, unknown>;
        const current = isRecord(entries[trimmedSkillKey]) ? entries[trimmedSkillKey] : {};
        entries[trimmedSkillKey] = {
          ...current,
          enabled,
        };
        await this.configRepository.write(config);
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async setManyEnabled(skillKeys: readonly string[], enabled: boolean) {
    const trimmedSkillKeys = [...new Set(skillKeys
      .map((skillKey) => typeof skillKey === 'string' ? skillKey.trim() : '')
      .filter(Boolean))];
    if (trimmedSkillKeys.length === 0) {
      return { success: false, error: 'skillKeys is required' };
    }
    try {
      await withOpenClawConfigLock(async () => {
        const config = await this.configRepository.read();
        if (!isRecord(config.skills)) {
          config.skills = {};
        }
        const skills = config.skills as Record<string, unknown>;
        if (!isRecord(skills.entries)) {
          skills.entries = {};
        }

        const entries = skills.entries as Record<string, unknown>;
        for (const skillKey of trimmedSkillKeys) {
          const current = isRecord(entries[skillKey]) ? entries[skillKey] : {};
          entries[skillKey] = {
            ...current,
            enabled,
          };
        }
        await this.configRepository.write(config);
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async listEffective() {
    const configs = await this.getAllConfigs();
    const installed = await this.clawHubSkillInventory.listInstalled() as InstalledClawHubSkill[];
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
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class SkillReadmePreviewRepository {
  constructor(
    private readonly workspace: Pick<OpenClawWorkspacePort, 'getPreviewRoots' | 'getDefaultSkillReadmePath'>,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  async read(skillKey: string, input: { filePath?: string; baseDir?: string }) {
    const allowedRoots = (await this.workspace.getPreviewRoots())
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => path.resolve(value));

    const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : '';
    const baseDir = typeof input.baseDir === 'string' ? input.baseDir.trim() : '';
    const candidatePath = filePath
      ? path.resolve(filePath)
      : baseDir
        ? path.resolve(path.join(baseDir, 'SKILL.md'))
        : path.resolve(this.workspace.getDefaultSkillReadmePath(skillKey));

    if (path.basename(candidatePath).toLowerCase() !== 'skill.md') {
      return badRequest('Only SKILL.md preview is supported');
    }

    let realFilePath = candidatePath;
    try {
      realFilePath = await this.fileSystem.realPath(candidatePath);
    } catch {
      return notFound('Skill preview not found');
    }

    const normalizedRoots = await Promise.all(allowedRoots.map(async (rootPath) => {
      try {
        return await this.fileSystem.realPath(rootPath);
      } catch {
        return rootPath;
      }
    }));

    if (!normalizedRoots.some((rootPath) => isPathInsideRoot(realFilePath, rootPath))) {
      return applicationResponse(403, { success: false, error: 'Skill preview path is outside allowed roots' });
    }

    try {
      const content = await this.fileSystem.readTextFile(realFilePath);
      return ok({
        success: true,
        content,
        filePath: realFilePath,
      });
    } catch (error) {
      return serverError(String(error));
    }
  }
}
