import { app, ipcMain } from 'electron';
import { existsSync, cpSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
  type TemplateFileName = 'AGENTS.md' | 'SOUL.md' | 'TOOLS.md' | 'IDENTITY.md' | 'USER.md';
  type TemplateCatalogEntry = {
    id: string;
    name: string;
    emoji?: string;
    summary?: string;
    categoryId?: string;
    subcategoryId?: string;
    order?: number;
    sourcePath?: string;
    files: TemplateFileName[];
  };
  type TemplateCategoryEntry = {
    id: string;
    order?: number;
  };
  type TemplateCatalogResult = {
    sourceDir?: string;
    categories: TemplateCategoryEntry[];
    templates: TemplateCatalogEntry[];
  };
  type TemplateDetail = {
    sourceDir?: string;
    template: TemplateCatalogEntry & {
      fileContents: Partial<Record<TemplateFileName, string>>;
    };
  };
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
  type TemplateCatalogMetadataTemplate = {
    categoryId?: string;
    subcategoryId?: string;
    order?: number;
    sourcePath?: string;
  };
  type TemplateCatalogMetadata = {
    categories: TemplateCategoryEntry[];
    templates: Record<string, TemplateCatalogMetadataTemplate>;
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
  const TEMPLATE_REQUIRED_FILES: readonly TemplateFileName[] = [
    'AGENTS.md',
    'SOUL.md',
    'TOOLS.md',
    'IDENTITY.md',
    'USER.md',
  ];

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

  function toDisplayNameFromSlug(slug: string): string {
    return slug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  }

  function looksLikeEmojiToken(token: string): boolean {
    return /[\p{Extended_Pictographic}\uFE0F]/u.test(token);
  }

  function getFirstBodyLine(content: string): string | undefined {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith('#')) {
        continue;
      }
      return trimmed;
    }
    return undefined;
  }

  function parseIdentityMetadata(identityContent: string, fallbackName: string): {
    name: string;
    emoji?: string;
    summary?: string;
  } {
    const lines = identityContent.split(/\r?\n/);
    let name = fallbackName;
    let emoji: string | undefined;
    let summary: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith('#')) {
        const heading = trimmed.replace(/^#+\s*/, '').trim();
        if (!heading) {
          continue;
        }
        const parts = heading.split(/\s+/);
        if (parts.length > 1 && looksLikeEmojiToken(parts[0])) {
          emoji = parts[0];
          name = parts.slice(1).join(' ') || fallbackName;
        } else {
          name = heading;
        }
        continue;
      }
      summary = trimmed;
      break;
    }

    return { name, emoji, summary };
  }

  function resolveSubagentTemplateCandidates(): string[] {
    const cwd = process.cwd();
    const appPath = app.getAppPath();
    const resourcesPath = process.resourcesPath;
    const candidates = [
      process.env.MATCHACLAW_SUBAGENT_TEMPLATE_DIR,
      join(cwd, 'src', 'features', 'subagents', 'templates'),
      join(appPath, 'src', 'features', 'subagents', 'templates'),
      join(resourcesPath, 'resources', 'subagent-templates'),
      join(homedir(), '.openclaw', 'agency-agents'),
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => resolve(value));
    return [...new Set(candidates)];
  }

  function normalizeCategoryId(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const normalized = value.trim();
    return normalized ? normalized : undefined;
  }

  function normalizeOrder(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined;
    }
    return value;
  }

  function readTemplateCatalogMetadata(sourceDir: string): TemplateCatalogMetadata {
    const catalogPath = join(sourceDir, 'catalog.json');
    if (!existsSync(catalogPath)) {
      return {
        categories: [],
        templates: {},
      };
    }
    try {
      const rawText = readFileSync(catalogPath, 'utf8');
      const parsed = JSON.parse(rawText);
      if (!isRecord(parsed)) {
        return {
          categories: [],
          templates: {},
        };
      }

      const rawCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
      const categories = rawCategories
        .map((item): TemplateCategoryEntry | null => {
          if (!isRecord(item)) {
            return null;
          }
          const id = normalizeCategoryId(item.id);
          if (!id) {
            return null;
          }
          const order = normalizeOrder(item.order);
          return {
            id,
            ...(order !== undefined ? { order } : {}),
          };
        })
        .filter((item): item is TemplateCategoryEntry => Boolean(item));

      const rawTemplates = Array.isArray(parsed.templates) ? parsed.templates : [];
      const templates: Record<string, TemplateCatalogMetadataTemplate> = {};
      for (const item of rawTemplates) {
        if (!isRecord(item)) {
          continue;
        }
        const id = normalizeCategoryId(item.id);
        if (!id) {
          continue;
        }
        const categoryId = normalizeCategoryId(item.categoryId);
        const subcategoryId = normalizeCategoryId(item.subcategoryId);
        const order = normalizeOrder(item.order);
        const sourcePath = normalizeCategoryId(item.sourcePath);
        templates[id] = {
          ...(categoryId ? { categoryId } : {}),
          ...(subcategoryId ? { subcategoryId } : {}),
          ...(order !== undefined ? { order } : {}),
          ...(sourcePath ? { sourcePath } : {}),
        };
      }

      return {
        categories,
        templates,
      };
    } catch (error) {
      logger.warn(`Failed to parse subagent template catalog metadata from ${catalogPath}: ${String(error)}`);
      return {
        categories: [],
        templates: {},
      };
    }
  }

  function deriveTemplateCategories(
    templates: TemplateCatalogEntry[],
    metadataCategories: TemplateCategoryEntry[],
  ): TemplateCategoryEntry[] {
    const usedIds = new Set(
      templates
        .map((template) => template.categoryId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    if (usedIds.size === 0) {
      return [];
    }

    const fromMetadata = metadataCategories
      .filter((category) => usedIds.has(category.id))
      .sort((a, b) => {
        const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
        const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }
        return a.id.localeCompare(b.id);
      });

    const knownIds = new Set(fromMetadata.map((category) => category.id));
    const fallback = [...usedIds]
      .filter((id) => !knownIds.has(id))
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ id }));

    return [...fromMetadata, ...fallback];
  }

  function listTemplatesFromSource(sourceDir: string): TemplateCatalogEntry[] {
    const metadata = readTemplateCatalogMetadata(sourceDir);
    const entries = readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const templates: TemplateCatalogEntry[] = [];

    for (const id of entries) {
      const templateDir = join(sourceDir, id);
      const files = TEMPLATE_REQUIRED_FILES.filter((fileName) => existsSync(join(templateDir, fileName)));
      if (files.length === 0) {
        continue;
      }

      const identityPath = join(templateDir, 'IDENTITY.md');
      const agentsPath = join(templateDir, 'AGENTS.md');
      const fallbackName = toDisplayNameFromSlug(id) || id;
      const templateMetadata = metadata.templates[id];

      const identityContent = existsSync(identityPath) ? readFileSync(identityPath, 'utf8') : '';
      const agentsContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
      const identity = parseIdentityMetadata(identityContent, fallbackName);
      const summary = identity.summary ?? getFirstBodyLine(agentsContent);

      templates.push({
        id,
        name: identity.name || fallbackName,
        ...(identity.emoji ? { emoji: identity.emoji } : {}),
        ...(summary ? { summary } : {}),
        ...(templateMetadata?.categoryId ? { categoryId: templateMetadata.categoryId } : {}),
        ...(templateMetadata?.subcategoryId ? { subcategoryId: templateMetadata.subcategoryId } : {}),
        ...(templateMetadata?.order !== undefined ? { order: templateMetadata.order } : {}),
        ...(templateMetadata?.sourcePath ? { sourcePath: templateMetadata.sourcePath } : {}),
        files: [...files],
      });
    }

    return templates.sort((a, b) => {
      const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      return a.id.localeCompare(b.id);
    });
  }

  function getSubagentTemplateCatalog(): TemplateCatalogResult {
    const candidates = resolveSubagentTemplateCandidates();
    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        continue;
      }
      try {
        const templates = listTemplatesFromSource(candidate);
        if (templates.length > 0) {
          const metadata = readTemplateCatalogMetadata(candidate);
          const categories = deriveTemplateCategories(templates, metadata.categories);
          return {
            sourceDir: candidate,
            categories,
            templates,
          };
        }
      } catch (error) {
        logger.warn(`Failed to read subagent template catalog from ${candidate}: ${String(error)}`);
      }
    }
    return {
      categories: [],
      templates: [],
    };
  }

  function readTemplateDetailFromSource(sourceDir: string, templateId: string): TemplateDetail | undefined {
    const templates = listTemplatesFromSource(sourceDir);
    const base = templates.find((item) => item.id === templateId);
    if (!base) {
      return undefined;
    }
    const templateDir = join(sourceDir, templateId);
    const fileContents: Partial<Record<TemplateFileName, string>> = {};
    for (const fileName of TEMPLATE_REQUIRED_FILES) {
      const filePath = join(templateDir, fileName);
      if (!existsSync(filePath)) {
        continue;
      }
      fileContents[fileName] = readFileSync(filePath, 'utf8');
    }
    return {
      sourceDir,
      template: {
        ...base,
        fileContents,
      },
    };
  }

  function getSubagentTemplate(templateIdRaw: unknown): TemplateDetail | null {
    const templateId = typeof templateIdRaw === 'string' ? templateIdRaw.trim() : '';
    if (!templateId) {
      return null;
    }
    for (const sourceDir of resolveSubagentTemplateCandidates()) {
      if (!existsSync(sourceDir)) {
        continue;
      }
      try {
        const detail = readTemplateDetailFromSource(sourceDir, templateId);
        if (detail) {
          return detail;
        }
      } catch (error) {
        logger.warn(`Failed to read subagent template "${templateId}" from ${sourceDir}: ${String(error)}`);
      }
    }
    return null;
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

  function disableTaskPluginInConfig(pluginId: string): void {
    const config = readOpenClawConfigJson();
    let changed = false;

    if (isRecord(config.plugins)) {
      const plugins = { ...config.plugins };
      if (Array.isArray(plugins.allow)) {
        const allow = plugins.allow.filter((item): item is string => typeof item === 'string');
        const nextAllow = allow.filter((item) => item !== pluginId);
        if (nextAllow.length !== allow.length) {
          plugins.allow = nextAllow;
          changed = true;
        }
      }
      if (isRecord(plugins.entries) && Object.prototype.hasOwnProperty.call(plugins.entries, pluginId)) {
        const entries = { ...plugins.entries };
        delete entries[pluginId];
        plugins.entries = entries;
        changed = true;
      }
      if (isRecord(plugins.installs) && Object.prototype.hasOwnProperty.call(plugins.installs, pluginId)) {
        const installs = { ...plugins.installs };
        delete installs[pluginId];
        plugins.installs = installs;
        changed = true;
      }
      if (changed) {
        config.plugins = plugins;
      }
    }

    if (isRecord(config.skills) && isRecord(config.skills.entries) && Object.prototype.hasOwnProperty.call(config.skills.entries, pluginId)) {
      const skills = { ...config.skills };
      const skillEntries = { ...config.skills.entries };
      delete skillEntries[pluginId];
      skills.entries = skillEntries;
      config.skills = skills;
      changed = true;
    }

    if (changed) {
      writeOpenClawConfigJson(config);
    }
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

  // Get read-only subagent templates (catalog only, no creation side effects)
  ipcMain.handle('openclaw:getSubagentTemplateCatalog', () => {
    return getSubagentTemplateCatalog();
  });
  ipcMain.handle('openclaw:getSubagentTemplate', (_, templateId: unknown) => {
    return getSubagentTemplate(templateId);
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

  // Uninstall and disable task-manager plugin
  ipcMain.handle('task:pluginUninstall', async () => {
    const pluginId = 'task-manager';
    const pluginDir = join(homedir(), '.openclaw', 'extensions', pluginId);
    const manifestPath = join(pluginDir, 'openclaw.plugin.json');
    const wasInstalled = existsSync(pluginDir) || existsSync(manifestPath);
    try {
      disableTaskPluginInConfig(pluginId);
      rmSync(pluginDir, { recursive: true, force: true });
      scheduleGatewayChannelRestart('task:pluginUninstall');

      return {
        success: true,
        installed: false,
        enabled: false,
        skillEnabled: false,
        removedPath: pluginDir,
        wasInstalled,
      };
    } catch (error) {
      logger.error('Failed to uninstall task manager plugin:', error);
      return {
        success: false,
        installed: existsSync(manifestPath),
        enabled: false,
        skillEnabled: false,
        removedPath: pluginDir,
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
