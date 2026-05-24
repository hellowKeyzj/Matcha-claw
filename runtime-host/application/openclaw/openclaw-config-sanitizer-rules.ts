import { isAbsolute } from 'path';
import { OPENCLAW_PROVIDER_KEY_MOONSHOT } from '../providers/provider-runtime-rules';
import { STRICT_SCHEMA_CHANNEL_IDS } from '../channels/channel-plugin-bindings';

const BUILTIN_CHANNEL_IDS = new Set([
  'feishu',
  'telegram',
  'slack',
  'signal',
  'imessage',
  'matrix',
  'line',
  'msteams',
  'googlechat',
  'mattermost',
]);

const FEISHU_ACCOUNT_SCOPED_KEYS = [
  'appId',
  'appSecret',
  'encryptKey',
  'verificationToken',
  'name',
  'domain',
  'connectionMode',
  'webhookPath',
  'webhookPort',
  'dmPolicy',
  'allowFrom',
  'groupPolicy',
  'groupAllowFrom',
  'requireMention',
  'respondToMentionAll',
  'groups',
  'historyLimit',
  'dmHistoryLimit',
  'dms',
  'textChunkLimit',
  'chunkMode',
  'blockStreamingCoalesce',
  'mediaMaxMb',
  'heartbeat',
  'replyMode',
  'streaming',
  'blockStreaming',
  'toolUseDisplay',
  'tools',
  'footer',
  'markdown',
  'configWrites',
  'capabilities',
  'dedup',
  'reactionNotifications',
  'threadSession',
  'uat',
] as const;

export interface OpenClawConfigSanitizerRulesDeps {
  fileExists(pathname: string): Promise<boolean>;
  discoverBundledPluginIds(): Promise<Set<string>>;
  ensureOAuthPluginEnabled(config: Record<string, unknown>, provider: string): Promise<boolean>;
  localBuildOpenClawPluginsDir: string;
  info(message: string): void;
}

async function removeDisabledUndiscoveredPluginEntries(
  plugins: Record<string, unknown>,
  deps: OpenClawConfigSanitizerRulesDeps,
): Promise<boolean> {
  const entries = (
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? plugins.entries as Record<string, Record<string, unknown>>
      : null
  );
  if (!entries) {
    return false;
  }

  const allow = new Set(
    Array.isArray(plugins.allow)
      ? (plugins.allow as unknown[]).filter((value): value is string => typeof value === 'string')
      : [],
  );
  const discoveredPluginIds = await deps.discoverBundledPluginIds();
  let modified = false;

  for (const [pluginId, entry] of Object.entries(entries)) {
    if (
      allow.has(pluginId)
      || discoveredPluginIds.has(pluginId)
      || BUILTIN_CHANNEL_IDS.has(pluginId)
      || entry.enabled === true
    ) {
      continue;
    }
    delete entries[pluginId];
    modified = true;
    deps.info(`[sanitize] Removed stale disabled plugins.entries.${pluginId} because the plugin is not installed`);
  }

  if (modified && Object.keys(entries).length === 0) {
    delete plugins.entries;
  }

  return modified;
}

function isBundledPluginLoadPath(
  pathname: string,
  deps: OpenClawConfigSanitizerRulesDeps,
): boolean {
  const normalized = pathname.replace(/\\/g, '/');
  if (normalized.includes('node_modules/openclaw/extensions')) {
    return true;
  }
  if (!isAbsolute(pathname)) {
    return false;
  }
  const localBuildPluginsRoot = deps.localBuildOpenClawPluginsDir.replace(/\\/g, '/');
  return normalized === localBuildPluginsRoot || normalized.startsWith(`${localBuildPluginsRoot}/`);
}

async function sanitizePluginsLoadPaths(
  config: Record<string, unknown>,
  deps: OpenClawConfigSanitizerRulesDeps,
): Promise<boolean> {
  const plugins = config.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return false;
  }

  const pluginsObj = plugins as Record<string, unknown>;
  let modified = false;

  const sanitizePathList = async (list: unknown[]): Promise<unknown[]> => {
    const retained: unknown[] = [];
    for (const entry of list) {
      if (typeof entry !== 'string' || !isAbsolute(entry)) {
        retained.push(entry);
        continue;
      }
      if (isBundledPluginLoadPath(entry, deps) || !(await deps.fileExists(entry))) {
        deps.info(`[sanitize] Removing stale/bundled plugin path "${entry}"`);
        modified = true;
        continue;
      }
      retained.push(entry);
    }
    return retained;
  };

  if (Array.isArray(pluginsObj.load)) {
    const sanitized = await sanitizePathList(pluginsObj.load as unknown[]);
    if (sanitized.length !== (pluginsObj.load as unknown[]).length) {
      pluginsObj.load = sanitized;
      modified = true;
    }
    return modified;
  }

  if (!pluginsObj.load || typeof pluginsObj.load !== 'object' || Array.isArray(pluginsObj.load)) {
    return modified;
  }

  const loadObject = pluginsObj.load as Record<string, unknown>;
  if (!Array.isArray(loadObject.paths)) {
    return modified;
  }

  const original = loadObject.paths as unknown[];
  const sanitized = await sanitizePathList(original);
  if (sanitized.length !== original.length) {
    loadObject.paths = sanitized;
    modified = true;
  }
  return modified;
}

function removeMisplacedSkillKeys(config: Record<string, unknown>, deps: OpenClawConfigSanitizerRulesDeps): boolean {
  const skills = config.skills;
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
    return false;
  }
  let modified = false;
  const skillsObj = skills as Record<string, unknown>;
  for (const key of ['enabled', 'disabled']) {
    if (key in skillsObj) {
      deps.info(`[sanitize] Removing misplaced key "skills.${key}" from openclaw.json`);
      delete skillsObj[key];
      modified = true;
    }
  }
  return modified;
}

function ensureCommandsRestart(config: Record<string, unknown>, deps: OpenClawConfigSanitizerRulesDeps): boolean {
  const commands = (
    config.commands && typeof config.commands === 'object'
      ? { ...(config.commands as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  if (commands.restart === true) {
    return false;
  }
  commands.restart = true;
  config.commands = commands;
  deps.info('[sanitize] Enabling commands.restart for graceful reload support');
  return true;
}

function removeStaleMoonshotKimiApiKey(config: Record<string, unknown>, deps: OpenClawConfigSanitizerRulesDeps): boolean {
  const providers = ((config.models as Record<string, unknown> | undefined)?.providers as Record<string, unknown> | undefined) || {};
  if (!providers[OPENCLAW_PROVIDER_KEY_MOONSHOT]) {
    return false;
  }
  const tools = (config.tools as Record<string, unknown> | undefined) || {};
  const web = (tools.web as Record<string, unknown> | undefined) || {};
  const search = (web.search as Record<string, unknown> | undefined) || {};
  const kimi = (search.kimi as Record<string, unknown> | undefined) || {};
  if (!('apiKey' in kimi)) {
    return false;
  }
  deps.info('[sanitize] Removing stale key "tools.web.search.kimi.apiKey" from openclaw.json');
  delete kimi.apiKey;
  search.kimi = kimi;
  web.search = search;
  tools.web = web;
  config.tools = tools;
  return true;
}

function enforceToolDefaults(config: Record<string, unknown>, deps: OpenClawConfigSanitizerRulesDeps): boolean {
  const toolsConfig = (config.tools as Record<string, unknown> | undefined) || {};
  let modified = false;

  if (toolsConfig.profile !== 'full') {
    toolsConfig.profile = 'full';
    modified = true;
  }

  const sessions = (toolsConfig.sessions as Record<string, unknown> | undefined) || {};
  if (sessions.visibility !== 'all') {
    sessions.visibility = 'all';
    toolsConfig.sessions = sessions;
    modified = true;
  }

  if (!modified) {
    return false;
  }
  config.tools = toolsConfig;
  deps.info('[sanitize] Enforced tools.profile="full" and tools.sessions.visibility="all" for OpenClaw 3.8+');
  return true;
}

const MIN_BOOTSTRAP_MAX_CHARS = 32_000;
const MIN_BOOTSTRAP_TOTAL_MAX_CHARS = 100_000;

function enforceBootstrapCharLimits(config: Record<string, unknown>, deps: OpenClawConfigSanitizerRulesDeps): boolean {
  const agents = (config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)
    ? config.agents
    : {}) as Record<string, unknown>;
  const defaults = (agents.defaults && typeof agents.defaults === 'object' && !Array.isArray(agents.defaults)
    ? agents.defaults
    : {}) as Record<string, unknown>;

  let modified = false;

  const currentMax = typeof defaults.bootstrapMaxChars === 'number' ? defaults.bootstrapMaxChars : 0;
  if (currentMax < MIN_BOOTSTRAP_MAX_CHARS) {
    defaults.bootstrapMaxChars = MIN_BOOTSTRAP_MAX_CHARS;
    modified = true;
  }

  const currentTotal = typeof defaults.bootstrapTotalMaxChars === 'number' ? defaults.bootstrapTotalMaxChars : 0;
  if (currentTotal < MIN_BOOTSTRAP_TOTAL_MAX_CHARS) {
    defaults.bootstrapTotalMaxChars = MIN_BOOTSTRAP_TOTAL_MAX_CHARS;
    modified = true;
  }

  if (!modified) {
    return false;
  }
  agents.defaults = defaults;
  config.agents = agents;
  deps.info(`[sanitize] Enforced agents.defaults.bootstrapMaxChars>=${MIN_BOOTSTRAP_MAX_CHARS} and bootstrapTotalMaxChars>=${MIN_BOOTSTRAP_TOTAL_MAX_CHARS} to fit injected MatchaClaw context`);
  return true;
}

function sanitizeStrictSchemaChannels(config: Record<string, unknown>, deps: OpenClawConfigSanitizerRulesDeps): boolean {
  const channelsObj = (
    config.channels && typeof config.channels === 'object' && !Array.isArray(config.channels)
      ? config.channels as Record<string, Record<string, unknown>>
      : {}
  );
  let modified = false;
  for (const [channelId, section] of Object.entries(channelsObj)) {
    if (!STRICT_SCHEMA_CHANNEL_IDS.has(channelId) || !section || typeof section !== 'object' || Array.isArray(section)) {
      continue;
    }
    if ('accounts' in section) {
      delete section.accounts;
      modified = true;
      deps.info(`[sanitize] Removed incompatible channels.${channelId}.accounts for strict-schema plugin`);
    }
    if ('defaultAccount' in section) {
      delete section.defaultAccount;
      modified = true;
      deps.info(`[sanitize] Removed incompatible channels.${channelId}.defaultAccount for strict-schema plugin`);
    }
  }
  return modified;
}

function sanitizeDiscordGuildChannelConfig(channelConfig: unknown): boolean {
  if (!channelConfig || typeof channelConfig !== 'object' || Array.isArray(channelConfig)) {
    return false;
  }
  const channel = channelConfig as Record<string, unknown>;
  let modified = false;
  if (channel.allow === false && channel.enabled === undefined) {
    channel.enabled = false;
    modified = true;
  }
  if ('allow' in channel) {
    delete channel.allow;
    modified = true;
  }
  return modified;
}

function sanitizeDiscordGuilds(target: unknown): boolean {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return false;
  }
  const guilds = (target as Record<string, unknown>).guilds;
  if (!guilds || typeof guilds !== 'object' || Array.isArray(guilds)) {
    return false;
  }
  let modified = false;
  for (const guildConfig of Object.values(guilds as Record<string, unknown>)) {
    if (!guildConfig || typeof guildConfig !== 'object' || Array.isArray(guildConfig)) {
      continue;
    }
    const channels = (guildConfig as Record<string, unknown>).channels;
    if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
      continue;
    }
    for (const channelConfig of Object.values(channels as Record<string, unknown>)) {
      modified = sanitizeDiscordGuildChannelConfig(channelConfig) || modified;
    }
  }
  return modified;
}

function sanitizeDiscordChannelConfig(config: Record<string, unknown>, deps: OpenClawConfigSanitizerRulesDeps): boolean {
  const channels = (
    config.channels && typeof config.channels === 'object' && !Array.isArray(config.channels)
      ? config.channels as Record<string, Record<string, unknown>>
      : {}
  );
  const discord = channels.discord;
  if (!discord || typeof discord !== 'object' || Array.isArray(discord)) {
    return false;
  }
  let modified = sanitizeDiscordGuilds(discord);
  const accounts = discord.accounts && typeof discord.accounts === 'object' && !Array.isArray(discord.accounts)
    ? discord.accounts as Record<string, unknown>
    : {};
  for (const accountConfig of Object.values(accounts)) {
    modified = sanitizeDiscordGuilds(accountConfig) || modified;
  }
  if (modified) {
    deps.info('[sanitize] Removed incompatible Discord channel allow flags');
  }
  return modified;
}

function migrateFeishuDefaultAccountToTopLevel(
  config: Record<string, unknown>,
  deps: OpenClawConfigSanitizerRulesDeps,
): boolean {
  const channels = (
    config.channels && typeof config.channels === 'object' && !Array.isArray(config.channels)
      ? config.channels as Record<string, Record<string, unknown>>
      : {}
  );
  const feishu = channels.feishu;
  if (!feishu || typeof feishu !== 'object' || Array.isArray(feishu)) {
    return false;
  }
  const accounts = (
    feishu.accounts && typeof feishu.accounts === 'object' && !Array.isArray(feishu.accounts)
      ? feishu.accounts as Record<string, Record<string, unknown>>
      : null
  );
  const defaultAccount = accounts?.default;
  if (!defaultAccount || typeof defaultAccount !== 'object' || Array.isArray(defaultAccount)) {
    return false;
  }

  let modified = false;
  for (const key of FEISHU_ACCOUNT_SCOPED_KEYS) {
    if (defaultAccount[key] !== undefined && feishu[key] === undefined) {
      feishu[key] = defaultAccount[key];
      modified = true;
    }
  }

  delete accounts.default;
  modified = true;
  if (Object.keys(accounts).length === 0) {
    delete feishu.accounts;
  }
  if (feishu.defaultAccount === 'default') {
    delete feishu.defaultAccount;
  }

  deps.info('[sanitize] Migrated channels.feishu.accounts.default to top-level channels.feishu for openclaw-lark default account compatibility');
  return modified;
}

function migrateAllowId(
  allowList: string[],
  legacyId: string,
  canonicalId: string,
  deps: OpenClawConfigSanitizerRulesDeps,
): boolean {
  const legacyAllowIndex = allowList.indexOf(legacyId);
  if (legacyAllowIndex === -1) {
    return false;
  }
  if (!allowList.includes(canonicalId)) {
    allowList[legacyAllowIndex] = canonicalId;
  } else {
    allowList.splice(legacyAllowIndex, 1);
  }
  deps.info(`[sanitize] Migrated plugins.allow: ${legacyId} -> ${canonicalId}`);
  return true;
}

function migrateEntryId(
  entries: Record<string, Record<string, unknown>>,
  legacyId: string,
  canonicalId: string,
  deps: OpenClawConfigSanitizerRulesDeps,
): boolean {
  if (!entries[legacyId]) {
    return false;
  }
  if (!entries[canonicalId]) {
    entries[canonicalId] = entries[legacyId];
  }
  delete entries[legacyId];
  deps.info(`[sanitize] Migrated plugins.entries: ${legacyId} -> ${canonicalId}`);
  return true;
}

async function sanitizePlugins(config: Record<string, unknown>, deps: OpenClawConfigSanitizerRulesDeps): Promise<boolean> {
  const plugins = config.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return false;
  }
  const pluginsObj = plugins as Record<string, unknown>;
  const entries = (
    pluginsObj.entries && typeof pluginsObj.entries === 'object' && !Array.isArray(pluginsObj.entries)
      ? pluginsObj.entries as Record<string, Record<string, unknown>>
      : {}
  );
  const allowList = Array.isArray(pluginsObj.allow)
    ? (pluginsObj.allow as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  let modified = false;

  modified = migrateAllowId(allowList, 'feishu-openclaw-plugin', 'openclaw-lark', deps) || modified;
  modified = migrateAllowId(allowList, 'wecom-openclaw-plugin', 'wecom', deps) || modified;
  if (modified) {
    pluginsObj.allow = allowList;
  }

  modified = migrateEntryId(entries, 'feishu-openclaw-plugin', 'openclaw-lark', deps) || modified;
  modified = migrateEntryId(entries, 'wecom-openclaw-plugin', 'wecom', deps) || modified;

  const hasNewFeishu = allowList.includes('openclaw-lark') || Boolean(entries['openclaw-lark']);
  if (hasNewFeishu) {
    const bareFeishuIndex = allowList.indexOf('feishu');
    if (bareFeishuIndex !== -1) {
      allowList.splice(bareFeishuIndex, 1);
      pluginsObj.allow = allowList;
      modified = true;
      deps.info('[sanitize] Removed bare "feishu" from plugins.allow because openclaw-lark is configured');
    }
  }
  if (hasNewFeishu && (!entries.feishu || entries.feishu.enabled !== false)) {
    entries.feishu = {
      ...(entries.feishu ?? {}),
      enabled: false,
    };
    modified = true;
    deps.info('[sanitize] Disabled plugins.entries.feishu because openclaw-lark is configured');
  }

  const providers = ((config.models as Record<string, unknown> | undefined)?.providers as Record<string, unknown> | undefined) || {};
  const hasMiniMaxPluginResidue = allowList.includes('minimax')
    || allowList.includes('minimax-portal-auth')
    || Boolean(entries.minimax)
    || Boolean(entries['minimax-portal-auth']);
  if ((providers['minimax-portal'] || hasMiniMaxPluginResidue) && await deps.ensureOAuthPluginEnabled(config, 'minimax-portal')) {
    modified = true;
    deps.info('[sanitize] Normalized MiniMax OAuth plugin registration to bundled canonical plugin id');
  }

  const channelsObj = (
    config.channels && typeof config.channels === 'object' && !Array.isArray(config.channels)
      ? config.channels as Record<string, Record<string, unknown>>
      : {}
  );
  const configuredBuiltIns = new Set<string>();
  for (const [channelId, section] of Object.entries(channelsObj)) {
    if (!BUILTIN_CHANNEL_IDS.has(channelId)) {
      continue;
    }
    if (!section || section.enabled === false) {
      continue;
    }
    if (Object.keys(section).length > 0) {
      configuredBuiltIns.add(channelId);
    }
  }

  const hasCanonicalFeishuPlugin = allowList.includes('openclaw-lark') || Boolean(entries?.['openclaw-lark']);
  const nextAllow = allowList.filter((pluginId) => {
    if (pluginId === 'feishu' && hasCanonicalFeishuPlugin) {
      return false;
    }
    if (BUILTIN_CHANNEL_IDS.has(pluginId)) {
      return configuredBuiltIns.has(pluginId);
    }
    return true;
  });
  for (const channelId of configuredBuiltIns) {
    if (!nextAllow.includes(channelId)) {
      nextAllow.push(channelId);
    }
  }

  if (JSON.stringify(nextAllow) !== JSON.stringify(allowList)) {
    if (nextAllow.length > 0) {
      pluginsObj.allow = nextAllow;
    } else {
      delete pluginsObj.allow;
    }
    modified = true;
  }

  if (await removeDisabledUndiscoveredPluginEntries(pluginsObj, deps)) {
    modified = true;
  }

  if (Array.isArray(pluginsObj.allow) && pluginsObj.allow.length === 0) {
    delete pluginsObj.allow;
    modified = true;
  }
  if (
    pluginsObj.entries
    && typeof pluginsObj.entries === 'object'
    && !Array.isArray(pluginsObj.entries)
    && Object.keys(pluginsObj.entries as Record<string, unknown>).length === 0
  ) {
    delete pluginsObj.entries;
    modified = true;
  }
  const pluginKeysExcludingEnabled = Object.keys(pluginsObj).filter((key) => key !== 'enabled');
  if (pluginsObj.enabled === true && pluginKeysExcludingEnabled.length === 0) {
    delete pluginsObj.enabled;
    modified = true;
  }
  if (Object.keys(pluginsObj).length === 0) {
    delete config.plugins;
    modified = true;
  }

  return modified;
}

export async function applyOpenClawConfigSanitizerRules(
  config: Record<string, unknown>,
  deps: OpenClawConfigSanitizerRulesDeps,
): Promise<boolean> {
  let modified = false;
  modified = removeMisplacedSkillKeys(config, deps) || modified;
  modified = ensureCommandsRestart(config, deps) || modified;
  modified = removeStaleMoonshotKimiApiKey(config, deps) || modified;
  modified = enforceToolDefaults(config, deps) || modified;
  modified = enforceBootstrapCharLimits(config, deps) || modified;
  modified = await sanitizePluginsLoadPaths(config, deps) || modified;
  modified = sanitizeStrictSchemaChannels(config, deps) || modified;
  modified = sanitizeDiscordChannelConfig(config, deps) || modified;
  modified = migrateFeishuDefaultAccountToTopLevel(config, deps) || modified;
  modified = await sanitizePlugins(config, deps) || modified;
  return modified;
}
