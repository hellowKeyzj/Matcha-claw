import { app, ipcMain } from 'electron';
import { existsSync, cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GatewayManager } from '../../../gateway/manager';
import {
  getOpenClawStatus,
  getOpenClawDir,
  getOpenClawConfigDir,
  getOpenClawSkillsDir,
  ensureDir,
} from '../../../utils/paths';
import { getOpenClawCliCommand } from '../../../utils/openclaw-cli';
import { logger } from '../../../utils/logger';
import {
  saveChannelConfig,
  getChannelConfig,
  getChannelFormValues,
  deleteChannelConfig,
  listConfiguredChannels,
  setChannelEnabled,
  validateChannelConfig,
  validateChannelCredentials,
} from '../../../utils/channel-config';
import { upsertPluginInstallRecord, type InstallSource } from '../../../utils/plugin-install-record';
import { resolveMainWorkspaceDir, resolveTaskWorkspaceDirs } from '../../../utils/task-workspace-scope';

export function registerOpenClawHandlers(gatewayManager: GatewayManager): void {
  type PluginInstallAudit = {
    source: InstallSource;
    installPath?: string;
    sourcePath?: string;
    spec?: string;
    version?: string;
  };

  type ManagedPluginInstallResult = {
    installed: boolean;
    warning?: string;
    installedPath?: string;
    sourcePath?: string;
    version?: string;
  };

  const scheduleGatewayChannelRestart = (reason: string): void => {
    if (gatewayManager.getStatus().state !== 'stopped') {
      logger.info(`Scheduling Gateway restart after ${reason}`);
      gatewayManager.debouncedRestart();
    } else {
      logger.info(`Gateway is stopped; skip immediate restart after ${reason}`);
    }
  };

  const OPENCLAW_CONFIG_PATH = join(getOpenClawConfigDir(), 'openclaw.json');

  type OpenClawConfigObject = Record<string, unknown>;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function readOpenClawConfigJson(): OpenClawConfigObject {
    if (!existsSync(OPENCLAW_CONFIG_PATH)) {
      return {};
    }
    try {
      const raw = readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeOpenClawConfigJson(config: OpenClawConfigObject): void {
    mkdirSync(getOpenClawConfigDir(), { recursive: true });
    writeFileSync(OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  function getInstalledPluginVersion(pluginId: string): string | undefined {
    const pkgPath = join(homedir(), '.openclaw', 'extensions', pluginId, 'package.json');
    if (!existsSync(pkgPath)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  }

  function readPluginEnabledFromConfig(config: OpenClawConfigObject, pluginId: string): boolean {
    const plugins = isRecord(config.plugins) ? config.plugins : {};
    const allow = Array.isArray(plugins.allow)
      ? plugins.allow.filter((item): item is string => typeof item === 'string')
      : [];
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const pluginEntry = isRecord(entries[pluginId]) ? entries[pluginId] : {};
    const enabled = pluginEntry.enabled;
    if (typeof enabled === 'boolean') {
      return allow.includes(pluginId) && enabled;
    }
    return allow.includes(pluginId);
  }

  function readSkillEnabledFromConfig(config: OpenClawConfigObject, skillId: string): boolean {
    const skills = isRecord(config.skills) ? config.skills : {};
    const entries = isRecord(skills.entries) ? skills.entries : {};
    const skillEntry = isRecord(entries[skillId]) ? entries[skillId] : {};
    const enabled = skillEntry.enabled;
    if (typeof enabled === 'boolean') {
      return enabled;
    }
    return false;
  }

  function ensureTaskPluginEnabledInConfig(pluginId: string, audit?: PluginInstallAudit): void {
    const config = readOpenClawConfigJson();
    const plugins = isRecord(config.plugins) ? { ...config.plugins } : {};
    const allow = Array.isArray(plugins.allow)
      ? plugins.allow.filter((item): item is string => typeof item === 'string')
      : [];
    if (!allow.includes(pluginId)) {
      allow.push(pluginId);
    }
    plugins.allow = allow;

    const pluginEntries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
    const pluginEntry = isRecord(pluginEntries[pluginId]) ? { ...pluginEntries[pluginId] } : {};
    pluginEntry.enabled = true;
    pluginEntries[pluginId] = pluginEntry;
    plugins.entries = pluginEntries;
    config.plugins = plugins;

    const skills = isRecord(config.skills) ? { ...config.skills } : {};
    const skillEntries = isRecord(skills.entries) ? { ...skills.entries } : {};
    const taskSkill = isRecord(skillEntries[pluginId]) ? { ...skillEntries[pluginId] } : {};
    taskSkill.enabled = true;
    skillEntries[pluginId] = taskSkill;
    skills.entries = skillEntries;
    config.skills = skills;

    const { nextConfig } = upsertPluginInstallRecord(config, {
      pluginId,
      source: audit?.source ?? 'path',
      installPath: audit?.installPath ?? join(homedir(), '.openclaw', 'extensions', pluginId),
      sourcePath: audit?.sourcePath,
      spec: audit?.spec,
      version: audit?.version ?? getInstalledPluginVersion(pluginId),
    });

    writeOpenClawConfigJson(nextConfig);
  }

  function ensurePluginInstallRecordInConfig(pluginId: string, audit: PluginInstallAudit): void {
    const config = readOpenClawConfigJson();
    const { nextConfig, changed } = upsertPluginInstallRecord(config, {
      pluginId,
      source: audit.source,
      installPath: audit.installPath,
      sourcePath: audit.sourcePath,
      spec: audit.spec,
      version: audit.version,
    });
    if (changed) {
      writeOpenClawConfigJson(nextConfig);
    }
  }

  async function ensureDingTalkPluginInstalled(): Promise<ManagedPluginInstallResult> {
    const targetDir = join(homedir(), '.openclaw', 'extensions', 'dingtalk');
    const targetManifest = join(targetDir, 'openclaw.plugin.json');

    if (existsSync(targetManifest)) {
      logger.info('DingTalk plugin already installed from local mirror');
      return {
        installed: true,
        installedPath: targetDir,
        version: getInstalledPluginVersion('dingtalk'),
      };
    }

    const candidateSources = app.isPackaged
      ? [
        join(process.resourcesPath, 'openclaw-plugins', 'dingtalk'),
        join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', 'dingtalk'),
        join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', 'dingtalk')
      ]
      : [
        join(app.getAppPath(), 'build', 'openclaw-plugins', 'dingtalk'),
        join(process.cwd(), 'build', 'openclaw-plugins', 'dingtalk'),
        join(__dirname, '../../build/openclaw-plugins/dingtalk'),
      ];

    const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
    if (!sourceDir) {
      logger.warn('Bundled DingTalk plugin mirror not found in candidate paths', { candidateSources });
      return {
        installed: false,
        warning: `Bundled DingTalk plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
      };
    }

    try {
      mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true, dereference: true });

      if (!existsSync(targetManifest)) {
        return { installed: false, warning: 'Failed to install DingTalk plugin mirror (manifest missing).' };
      }

      logger.info(`Installed DingTalk plugin from bundled mirror: ${sourceDir}`);
      return {
        installed: true,
        installedPath: targetDir,
        sourcePath: sourceDir,
        version: getInstalledPluginVersion('dingtalk'),
      };
    } catch (error) {
      logger.warn('Failed to install DingTalk plugin from bundled mirror:', error);
      return {
        installed: false,
        warning: 'Failed to install bundled DingTalk plugin mirror',
      };
    }
  }

  async function ensureWeComPluginInstalled(): Promise<ManagedPluginInstallResult> {
    const targetDir = join(homedir(), '.openclaw', 'extensions', 'wecom');
    const targetManifest = join(targetDir, 'openclaw.plugin.json');

    if (existsSync(targetManifest)) {
      logger.info('WeCom plugin already installed from local mirror');
      return {
        installed: true,
        installedPath: targetDir,
        version: getInstalledPluginVersion('wecom'),
      };
    }

    const candidateSources = app.isPackaged
      ? [
          join(process.resourcesPath, 'openclaw-plugins', 'wecom'),
          join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', 'wecom'),
          join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', 'wecom')
        ]
      : [
          join(app.getAppPath(), 'build', 'openclaw-plugins', 'wecom'),
          join(process.cwd(), 'build', 'openclaw-plugins', 'wecom'),
          join(__dirname, '../../build/openclaw-plugins/wecom'),
        ];

    const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
    if (!sourceDir) {
      logger.warn('Bundled WeCom plugin mirror not found in candidate paths', { candidateSources });
      return {
        installed: false,
        warning: `Bundled WeCom plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
      };
    }

    try {
      mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true, dereference: true });

      if (!existsSync(targetManifest)) {
        return { installed: false, warning: 'Failed to install WeCom plugin mirror (manifest missing).' };
      }

      logger.info(`Installed WeCom plugin from bundled mirror: ${sourceDir}`);
      return {
        installed: true,
        installedPath: targetDir,
        sourcePath: sourceDir,
        version: getInstalledPluginVersion('wecom'),
      };
    } catch (error) {
      logger.warn('Failed to install WeCom plugin from bundled mirror:', error);
      return {
        installed: false,
        warning: 'Failed to install bundled WeCom plugin mirror',
      };
    }
  }

  async function ensureQQBotPluginInstalled(): Promise<ManagedPluginInstallResult> {
    const targetDir = join(homedir(), '.openclaw', 'extensions', 'qqbot');
    const targetManifest = join(targetDir, 'openclaw.plugin.json');

    if (existsSync(targetManifest)) {
      logger.info('QQ Bot plugin already installed from local mirror');
      return {
        installed: true,
        installedPath: targetDir,
        version: getInstalledPluginVersion('qqbot'),
      };
    }

    const candidateSources = app.isPackaged
      ? [
          join(process.resourcesPath, 'openclaw-plugins', 'qqbot'),
          join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', 'qqbot'),
          join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', 'qqbot')
        ]
      : [
          join(app.getAppPath(), 'build', 'openclaw-plugins', 'qqbot'),
          join(process.cwd(), 'build', 'openclaw-plugins', 'qqbot'),
          join(__dirname, '../../build/openclaw-plugins/qqbot'),
        ];

    const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
    if (!sourceDir) {
      logger.warn('Bundled QQ Bot plugin mirror not found in candidate paths', { candidateSources });
      return {
        installed: false,
        warning: `Bundled QQ Bot plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
      };
    }

    try {
      mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true, dereference: true });

      if (!existsSync(targetManifest)) {
        return { installed: false, warning: 'Failed to install QQ Bot plugin mirror (manifest missing).' };
      }

      logger.info(`Installed QQ Bot plugin from bundled mirror: ${sourceDir}`);
      return {
        installed: true,
        installedPath: targetDir,
        sourcePath: sourceDir,
        version: getInstalledPluginVersion('qqbot'),
      };
    } catch (error) {
      logger.warn('Failed to install QQ Bot plugin from bundled mirror:', error);
      return {
        installed: false,
        warning: 'Failed to install bundled QQ Bot plugin mirror',
      };
    }
  }

  async function ensureTaskManagerPluginInstalled(): Promise<{
    installed: boolean;
    warning?: string;
    installedPath?: string;
    sourcePath?: string;
    version?: string;
  }> {
    const pluginId = 'task-manager';
    const targetDir = join(homedir(), '.openclaw', 'extensions', pluginId);
    const targetManifest = join(targetDir, 'openclaw.plugin.json');

    if (existsSync(targetManifest)) {
      return {
        installed: true,
        installedPath: targetDir,
        version: getInstalledPluginVersion(pluginId),
      };
    }

    const candidateSources = app.isPackaged
      ? [
          join(process.resourcesPath, 'openclaw-plugins', pluginId),
          join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', pluginId),
          join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', pluginId),
        ]
      : [
          join(app.getAppPath(), 'build', 'openclaw-plugins', pluginId),
          join(process.cwd(), 'build', 'openclaw-plugins', pluginId),
          join(__dirname, '../../build/openclaw-plugins/task-manager'),
          join(process.cwd(), 'packages', 'openclaw-task-manager-plugin'),
          join(app.getAppPath(), 'packages', 'openclaw-task-manager-plugin'),
          join(__dirname, '../../packages/openclaw-task-manager-plugin'),
        ];

    const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
    if (!sourceDir) {
      logger.warn('Task manager plugin source not found in candidate paths', { candidateSources });
      return {
        installed: false,
        warning: `Task manager plugin source not found. Checked: ${candidateSources.join(' | ')}`,
      };
    }

    try {
      mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true, dereference: true });

      if (!existsSync(targetManifest)) {
        return { installed: false, warning: 'Failed to install task-manager plugin (manifest missing)' };
      }
      return {
        installed: true,
        installedPath: targetDir,
        sourcePath: sourceDir,
        version: getInstalledPluginVersion(pluginId),
      };
    } catch (error) {
      logger.warn('Failed to install task-manager plugin:', error);
      return {
        installed: false,
        warning: 'Failed to install task-manager plugin',
      };
    }
  }

  // Get OpenClaw package status
  ipcMain.handle('openclaw:status', () => {
    const status = getOpenClawStatus();
    logger.info('openclaw:status IPC called', status);
    return status;
  });

  // Check if OpenClaw is ready (package present)
  ipcMain.handle('openclaw:isReady', () => {
    const status = getOpenClawStatus();
    return status.packageExists;
  });

  // Get the resolved OpenClaw directory path (for diagnostics)
  ipcMain.handle('openclaw:getDir', () => {
    return getOpenClawDir();
  });

  // Get the OpenClaw config directory (~/.openclaw)
  ipcMain.handle('openclaw:getConfigDir', () => {
    return getOpenClawConfigDir();
  });

  // Get OpenClaw default workspace directory from openclaw.json
  ipcMain.handle('openclaw:getWorkspaceDir', () => {
    const config = readOpenClawConfigJson();
    return resolveMainWorkspaceDir(config, getOpenClawConfigDir());
  });

  // Get all workspace directories related to task manager scope.
  ipcMain.handle('openclaw:getTaskWorkspaceDirs', () => {
    const config = readOpenClawConfigJson();
    return resolveTaskWorkspaceDirs(config, getOpenClawConfigDir());
  });

  // Get the OpenClaw skills directory (~/.openclaw/skills)
  ipcMain.handle('openclaw:getSkillsDir', () => {
    const dir = getOpenClawSkillsDir();
    ensureDir(dir);
    return dir;
  });

  // Get a shell command to run OpenClaw CLI without modifying PATH
  ipcMain.handle('openclaw:getCliCommand', () => {
    try {
      const status = getOpenClawStatus();
      if (!status.packageExists) {
        return { success: false, error: `OpenClaw package not found at: ${status.dir}` };
      }
      if (!existsSync(status.entryPath)) {
        return { success: false, error: `OpenClaw entry script not found at: ${status.entryPath}` };
      }
      return { success: true, command: getOpenClawCliCommand() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Task manager plugin status
  ipcMain.handle('task:pluginStatus', async () => {
    const pluginId = 'task-manager';
    const pluginDir = join(homedir(), '.openclaw', 'extensions', pluginId);
    const manifestPath = join(pluginDir, 'openclaw.plugin.json');
    const config = readOpenClawConfigJson();
    return {
      installed: existsSync(manifestPath),
      enabled: readPluginEnabledFromConfig(config, pluginId),
      skillEnabled: readSkillEnabledFromConfig(config, pluginId),
      version: getInstalledPluginVersion(pluginId),
      pluginDir,
    };
  });

  // Install and enable task-manager plugin
  ipcMain.handle('task:pluginInstall', async () => {
    try {
      const installResult = await ensureTaskManagerPluginInstalled();
      if (!installResult.installed) {
        return {
          success: false,
          error: installResult.warning || 'Task manager plugin install failed',
        };
      }

      ensureTaskPluginEnabledInConfig('task-manager', {
        source: 'path',
        installPath: installResult.installedPath,
        sourcePath: installResult.sourcePath,
        version: installResult.version,
      });
      scheduleGatewayChannelRestart('task:pluginInstall');

      return {
        success: true,
        installed: true,
        enabled: true,
        skillEnabled: true,
        installedPath: installResult.installedPath,
        version: installResult.version,
      };
    } catch (error) {
      logger.error('Failed to install task manager plugin:', error);
      return {
        success: false,
        error: String(error),
      };
    }
  });


  // ==================== Channel Configuration Handlers ====================

  // Save channel configuration
  ipcMain.handle('channel:saveConfig', async (_, channelType: string, config: Record<string, unknown>) => {
    try {
      logger.info('channel:saveConfig', { channelType, keys: Object.keys(config || {}) });
      if (channelType === 'dingtalk') {
        const installResult = await ensureDingTalkPluginInstalled();
        if (!installResult.installed) {
          return {
            success: false,
            error: installResult.warning || 'DingTalk plugin install failed',
          };
        }
        await saveChannelConfig(channelType, config);
        ensurePluginInstallRecordInConfig('dingtalk', {
          source: 'path',
          installPath: installResult.installedPath,
          sourcePath: installResult.sourcePath,
          version: installResult.version,
        });
        scheduleGatewayChannelRestart(`channel:saveConfig (${channelType})`);
        return {
          success: true,
          pluginInstalled: installResult.installed,
          warning: installResult.warning,
        };
      }
      if (channelType === 'wecom') {
        const installResult = await ensureWeComPluginInstalled();
        if (!installResult.installed) {
          return {
            success: false,
            error: installResult.warning || 'WeCom plugin install failed',
          };
        }
        await saveChannelConfig(channelType, config);
        ensurePluginInstallRecordInConfig('wecom', {
          source: 'path',
          installPath: installResult.installedPath,
          sourcePath: installResult.sourcePath,
          version: installResult.version,
        });
        scheduleGatewayChannelRestart(`channel:saveConfig (${channelType})`);
        return {
          success: true,
          pluginInstalled: installResult.installed,
          warning: installResult.warning,
        };
      }
      if (channelType === 'qqbot') {
        const installResult = await ensureQQBotPluginInstalled();
        if (!installResult.installed) {
          return {
            success: false,
            error: installResult.warning || 'QQ Bot plugin install failed',
          };
        }
        await saveChannelConfig(channelType, config);
        ensurePluginInstallRecordInConfig('qqbot', {
          source: 'path',
          installPath: installResult.installedPath,
          sourcePath: installResult.sourcePath,
          version: installResult.version,
        });
        if (gatewayManager.getStatus().state !== 'stopped') {
          logger.info(`Scheduling Gateway reload after channel:saveConfig (${channelType})`);
          gatewayManager.debouncedReload();
        } else {
          logger.info(`Gateway is stopped; skip immediate reload after channel:saveConfig (${channelType})`);
        }
        return {
          success: true,
          pluginInstalled: installResult.installed,
          warning: installResult.warning,
        };
      }
      await saveChannelConfig(channelType, config);
      scheduleGatewayChannelRestart(`channel:saveConfig (${channelType})`);
      return { success: true };
    } catch (error) {
      console.error('Failed to save channel config:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get channel configuration
  ipcMain.handle('channel:getConfig', async (_, channelType: string) => {
    try {
      const config = await getChannelConfig(channelType);
      return { success: true, config };
    } catch (error) {
      console.error('Failed to get channel config:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get channel form values (reverse-transformed for UI pre-fill)
  ipcMain.handle('channel:getFormValues', async (_, channelType: string) => {
    try {
      const values = await getChannelFormValues(channelType);
      return { success: true, values };
    } catch (error) {
      console.error('Failed to get channel form values:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete channel configuration
  ipcMain.handle('channel:deleteConfig', async (_, channelType: string) => {
    try {
      await deleteChannelConfig(channelType);
      scheduleGatewayChannelRestart(`channel:deleteConfig (${channelType})`);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete channel config:', error);
      return { success: false, error: String(error) };
    }
  });

  // List configured channels
  ipcMain.handle('channel:listConfigured', async () => {
    try {
      const channels = await listConfiguredChannels();
      return { success: true, channels };
    } catch (error) {
      console.error('Failed to list channels:', error);
      return { success: false, error: String(error) };
    }
  });

  // Enable or disable a channel
  ipcMain.handle('channel:setEnabled', async (_, channelType: string, enabled: boolean) => {
    try {
      await setChannelEnabled(channelType, enabled);
      scheduleGatewayChannelRestart(`channel:setEnabled (${channelType}, enabled=${enabled})`);
      return { success: true };
    } catch (error) {
      console.error('Failed to set channel enabled:', error);
      return { success: false, error: String(error) };
    }
  });

  // Validate channel configuration
  ipcMain.handle('channel:validate', async (_, channelType: string) => {
    try {
      const result = await validateChannelConfig(channelType);
      return { success: true, ...result };
    } catch (error) {
      console.error('Failed to validate channel:', error);
      return { success: false, valid: false, errors: [String(error)], warnings: [] };
    }
  });

  // Validate channel credentials by calling actual service APIs (before saving)
  ipcMain.handle('channel:validateCredentials', async (_, channelType: string, config: Record<string, string>) => {
    try {
      const result = await validateChannelCredentials(channelType, config);
      return { success: true, ...result };
    } catch (error) {
      console.error('Failed to validate channel credentials:', error);
      return { success: false, valid: false, errors: [String(error)], warnings: [] };
    }
  });
}