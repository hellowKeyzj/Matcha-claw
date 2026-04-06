import { existsSync, readFileSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  expandHomePath,
  getOpenClawConfigDir,
  readOpenClawConfigJson,
  writeOpenClawConfigJson,
} from '../../api/storage/paths';
import { upsertPluginInstallRecord } from '../openclaw/plugin-install-record';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getTaskManagerPluginId() {
  return 'task-manager';
}

function getTaskManagerPluginDir() {
  return join(getOpenClawConfigDir(), 'extensions', getTaskManagerPluginId());
}

function getTaskManagerPluginManifestPath() {
  return join(getTaskManagerPluginDir(), 'openclaw.plugin.json');
}

function getTaskManagerPluginPackagePath() {
  return join(getTaskManagerPluginDir(), 'package.json');
}

function getTaskManagerPluginVersion() {
  const packagePath = getTaskManagerPluginPackagePath();
  if (!existsSync(packagePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (isRecord(parsed) && typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // ignore
  }
  return undefined;
}

function readPluginEnabledFromConfig(config: Record<string, any>, pluginId: string) {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const allow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((item) => typeof item === 'string')
    : [];
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const pluginEntry = isRecord(entries[pluginId]) ? entries[pluginId] : {};
  const enabled = pluginEntry.enabled;
  if (typeof enabled === 'boolean') {
    return allow.includes(pluginId) && enabled;
  }
  return allow.includes(pluginId);
}

function readSkillEnabledFromConfig(config: Record<string, any>, skillId: string) {
  const skills = isRecord(config.skills) ? config.skills : {};
  const entries = isRecord(skills.entries) ? skills.entries : {};
  const skillEntry = isRecord(entries[skillId]) ? entries[skillId] : {};
  return skillEntry.enabled === true;
}

function getTaskManagerPluginSourceCandidates() {
  const explicit = String(process.env.MATCHACLAW_RUNTIME_HOST_TASK_PLUGIN_SOURCE_DIR || '').trim();
  const packagedResourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  return [
    explicit,
    packagedResourcesPath ? join(packagedResourcesPath, 'openclaw-plugins', 'task-manager') : '',
    packagedResourcesPath ? join(packagedResourcesPath, 'app.asar.unpacked', 'openclaw-plugins', 'task-manager') : '',
    packagedResourcesPath ? join(packagedResourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', 'task-manager') : '',
    join(process.cwd(), 'packages', 'openclaw-task-manager-plugin'),
    resolve(join(__dirname, '../../../packages/openclaw-task-manager-plugin')),
    join(process.cwd(), 'build', 'openclaw-plugins', 'task-manager'),
    resolve(join(__dirname, '../../../build/openclaw-plugins/task-manager')),
  ]
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => resolve(expandHomePath(item)));
}

async function ensureInstalled() {
  const pluginDir = getTaskManagerPluginDir();
  const pluginManifestPath = getTaskManagerPluginManifestPath();
  if (existsSync(pluginManifestPath)) {
    return {
      installed: true,
      installedPath: pluginDir,
      version: getTaskManagerPluginVersion(),
    };
  }

  const candidateSources = getTaskManagerPluginSourceCandidates();
  const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
  if (!sourceDir) {
    return {
      installed: false,
      warning: `Task manager plugin source not found. Checked: ${candidateSources.join(' | ')}`,
    };
  }

  try {
    await fsPromises.mkdir(dirname(pluginDir), { recursive: true });
    await fsPromises.rm(pluginDir, { recursive: true, force: true });
    await fsPromises.cp(sourceDir, pluginDir, { recursive: true, dereference: true });
    if (!existsSync(pluginManifestPath)) {
      return {
        installed: false,
        warning: 'Failed to install task-manager plugin (manifest missing)',
      };
    }
    return {
      installed: true,
      installedPath: pluginDir,
      sourcePath: sourceDir,
      version: getTaskManagerPluginVersion(),
    };
  } catch (error) {
    return {
      installed: false,
      warning: `Failed to install task-manager plugin: ${String(error)}`,
    };
  }
}

async function enableInConfig(pluginId: string, audit?: {
  source?: 'path';
  installPath?: string;
  sourcePath?: string;
  version?: string;
}) {
  let config = readOpenClawConfigJson() as Record<string, any>;

  if (!isRecord(config.plugins)) {
    config.plugins = {};
  }
  const plugins = config.plugins;
  if (!Array.isArray(plugins.allow)) {
    plugins.allow = [];
  }
  const allow = plugins.allow.filter((item) => typeof item === 'string');
  if (!allow.includes(pluginId)) {
    allow.push(pluginId);
  }
  plugins.allow = allow;

  if (!isRecord(plugins.entries)) {
    plugins.entries = {};
  }
  const pluginEntry = isRecord(plugins.entries[pluginId]) ? plugins.entries[pluginId] : {};
  pluginEntry.enabled = true;
  plugins.entries[pluginId] = pluginEntry;

  if (!isRecord(config.skills)) {
    config.skills = {};
  }
  const skills = config.skills;
  if (!isRecord(skills.entries)) {
    skills.entries = {};
  }
  const skillEntry = isRecord(skills.entries[pluginId]) ? skills.entries[pluginId] : {};
  skillEntry.enabled = true;
  skills.entries[pluginId] = skillEntry;

  const result = upsertPluginInstallRecord(config, {
    pluginId,
    source: audit?.source ?? 'path',
    installPath: audit?.installPath ?? getTaskManagerPluginDir(),
    sourcePath: audit?.sourcePath,
    version: audit?.version ?? getTaskManagerPluginVersion(),
  });
  config = result.nextConfig as Record<string, any>;

  await writeOpenClawConfigJson(config);
}

async function disableInConfig(pluginId: string) {
  const config = readOpenClawConfigJson() as Record<string, any>;
  let changed = false;

  if (isRecord(config.plugins)) {
    const plugins = config.plugins;
    if (Array.isArray(plugins.allow)) {
      const currentAllow = plugins.allow.filter((item) => typeof item === 'string');
      const nextAllow = currentAllow.filter((item) => item !== pluginId);
      if (nextAllow.length !== currentAllow.length) {
        plugins.allow = nextAllow;
        changed = true;
      }
    }

    if (isRecord(plugins.entries) && Object.prototype.hasOwnProperty.call(plugins.entries, pluginId)) {
      delete plugins.entries[pluginId];
      changed = true;
    }
    if (isRecord(plugins.installs) && Object.prototype.hasOwnProperty.call(plugins.installs, pluginId)) {
      delete plugins.installs[pluginId];
      changed = true;
    }
  }

  if (isRecord(config.skills) && isRecord(config.skills.entries)
    && Object.prototype.hasOwnProperty.call(config.skills.entries, pluginId)) {
    delete config.skills.entries[pluginId];
    changed = true;
  }

  if (changed) {
    await writeOpenClawConfigJson(config);
  }
}

export class TaskPluginService {
  constructor(
    private readonly deps?: {
      refreshPluginCatalog?: () => Promise<void>;
    },
  ) {}

  async status() {
    const pluginId = getTaskManagerPluginId();
    const pluginDir = getTaskManagerPluginDir();
    const manifestPath = getTaskManagerPluginManifestPath();
    const config = readOpenClawConfigJson() as Record<string, any>;
    return {
      installed: existsSync(manifestPath),
      enabled: readPluginEnabledFromConfig(config, pluginId),
      skillEnabled: readSkillEnabledFromConfig(config, pluginId),
      version: getTaskManagerPluginVersion(),
      pluginDir,
    };
  }

  async install() {
    const pluginId = getTaskManagerPluginId();
    const installResult = await ensureInstalled();
    if (!installResult.installed) {
      return {
        success: false,
        error: installResult.warning || 'Task manager plugin install failed',
      };
    }
    await enableInConfig(pluginId, {
      source: 'path',
      installPath: installResult.installedPath,
      sourcePath: installResult.sourcePath,
      version: installResult.version,
    });
    await this.deps?.refreshPluginCatalog?.();
    return {
      success: true,
      installed: true,
      enabled: true,
      skillEnabled: true,
      installedPath: installResult.installedPath,
      version: installResult.version,
    };
  }

  async uninstall() {
    const pluginId = getTaskManagerPluginId();
    const pluginDir = getTaskManagerPluginDir();
    const wasInstalled = existsSync(pluginDir) || existsSync(getTaskManagerPluginManifestPath());
    await disableInConfig(pluginId);
    await fsPromises.rm(pluginDir, { recursive: true, force: true });
    await this.deps?.refreshPluginCatalog?.();
    return {
      success: true,
      installed: false,
      enabled: false,
      skillEnabled: false,
      removedPath: pluginDir,
      wasInstalled,
    };
  }

  getSkillsDir() {
    return join(getOpenClawConfigDir(), 'skills');
  }
}
