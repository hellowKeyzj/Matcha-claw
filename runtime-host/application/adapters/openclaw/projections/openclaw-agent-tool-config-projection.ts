import type { GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import type {
  AgentToolCatalogProfile,
  AgentToolCatalogRisk,
  AgentToolCatalogSource,
  AgentToolConfigGroup,
  AgentToolConfigOption,
  AgentToolConfigProjectionPort,
  AgentToolConfigView,
  AgentToolPolicy,
  SetAgentToolConfigCommand,
  SetAgentToolConfigResult,
} from '../../../subagents/agent-tool-config-contracts';
import type { SubagentConfigProjectionPort, SubagentConfigSnapshot } from '../../../subagents/subagent-config-contracts';

interface OpenClawAgentToolConfigProjectionDeps {
  readonly subagentConfigProjection: SubagentConfigProjectionPort;
  readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
}

interface AgentToolCatalog {
  readonly agentId: string;
  readonly profiles: readonly AgentToolCatalogProfile[];
  readonly groups: readonly AgentToolConfigGroup[];
  readonly toolOptions: readonly AgentToolConfigOption[];
  readonly policyKeys: ReadonlySet<string>;
}

const TOOL_CATALOG_RPC_TIMEOUT_MS = 60000;
const ALL_OPENCLAW_TOOLS_POLICY_KEY = 'group:openclaw';
const ALL_PLUGIN_TOOLS_POLICY_KEY = 'group:plugins';
const ALL_TOOLS_POLICY_KEY = '*';

export class OpenClawAgentToolConfigProjection implements AgentToolConfigProjectionPort {
  constructor(private readonly deps: OpenClawAgentToolConfigProjectionDeps) {}

  async readAgentToolConfig(agentId: string): Promise<AgentToolConfigView> {
    const snapshot = await this.deps.subagentConfigProjection.readConfig();
    const payload = toConfigPayload(snapshot);
    if (!hasConfiguredAgent(snapshot.config, agentId)) {
      return agentNotConfiguredToolConfigView(agentId, payload);
    }
    const catalog = await this.readToolCatalog(agentId);
    return buildView(agentId, payload, catalog);
  }

  async setAgentToolConfig(command: SetAgentToolConfigCommand): Promise<SetAgentToolConfigResult> {
    const snapshot = await this.deps.subagentConfigProjection.readConfig();
    const payload = toConfigPayload(snapshot);
    const currentConfig = snapshot.config;
    const currentRevision = snapshot.revision;
    if (!currentRevision || currentRevision !== command.revision) {
      if (!hasConfiguredAgent(currentConfig, command.agentId)) {
        return {
          resultType: 'staleRevision',
          latestView: agentNotConfiguredToolConfigView(command.agentId, payload),
        };
      }
      const latestCatalog = await this.readToolCatalog(command.agentId);
      return {
        resultType: 'staleRevision',
        latestView: buildView(command.agentId, payload, latestCatalog),
      };
    }

    if (!hasConfiguredAgent(currentConfig, command.agentId)) {
      return { resultType: 'unsupported', reason: 'agentNotConfigured' };
    }

    const catalog = await this.readToolCatalog(command.agentId);
    const invalidToolKeys = validateToolPolicySelection(command, catalog.policyKeys);
    if (invalidToolKeys.length > 0) {
      return { resultType: 'invalidToolKeys', unknownToolKeys: invalidToolKeys };
    }

    const nextConfig = applyAgentToolConfig(currentConfig, command);
    const replaceResult = await this.deps.subagentConfigProjection.replaceConfig({
      revision: command.revision,
      config: nextConfig,
    });
    if (replaceResult.resultType === 'staleRevision') {
      const latestPayload = toConfigPayload(replaceResult.latestSnapshot);
      if (!hasConfiguredAgent(replaceResult.latestSnapshot.config, command.agentId)) {
        return {
          resultType: 'staleRevision',
          latestView: agentNotConfiguredToolConfigView(command.agentId, latestPayload),
        };
      }
      const latestCatalog = await this.readToolCatalog(command.agentId);
      return {
        resultType: 'staleRevision',
        latestView: buildView(command.agentId, latestPayload, latestCatalog),
      };
    }

    const nextPayload = toConfigPayload(replaceResult.snapshot);
    return {
      resultType: 'updated',
      view: buildView(command.agentId, nextPayload, catalog),
    };
  }

  private async readToolCatalog(agentId: string): Promise<AgentToolCatalog> {
    const catalog = await this.deps.gateway.gatewayRpc('tools.catalog', { agentId }, TOOL_CATALOG_RPC_TIMEOUT_MS);
    return normalizeToolsCatalogResult(catalog, agentId);
  }
}

function toConfigPayload(snapshot: SubagentConfigSnapshot): Record<string, unknown> {
  return {
    config: snapshot.config,
    revision: snapshot.revision,
    hash: snapshot.revision,
    baseHash: snapshot.revision,
    ...(snapshot.path ? { path: snapshot.path } : {}),
    updatedAt: snapshot.updatedAt,
  };
}

function agentNotConfiguredToolConfigView(agentId: string, payload: Record<string, unknown>): AgentToolConfigView {
  return {
    agentId,
    support: { supportType: 'unsupported', reason: 'agentNotConfigured' },
    selectionMode: 'inheritsDefaultTools',
    toolPolicy: null,
    toolProfiles: [],
    toolGroups: [],
    toolOptions: [],
    revision: readConfigRevision(payload) ?? '',
    updatedAt: readOptionalNumberOrNull(payload.updatedAt) ?? null,
  };
}

function buildView(agentId: string, payload: Record<string, unknown>, catalog: AgentToolCatalog): AgentToolConfigView {
  const config = readRecord(payload.config);
  const agentToolEntry = readAgentToolEntry(config, agentId);
  if (agentToolEntry.entryType === 'agentNotConfigured') {
    return agentNotConfiguredToolConfigView(agentId, payload);
  }

  return {
    agentId,
    support: { supportType: 'supported' },
    selectionMode: agentToolEntry.entryType === 'inheritsDefaultTools' ? 'inheritsDefaultTools' : 'usesAgentToolPolicy',
    toolPolicy: agentToolEntry.entryType === 'usesAgentToolPolicy' ? agentToolEntry.toolPolicy : null,
    toolProfiles: catalog.profiles,
    toolGroups: catalog.groups,
    toolOptions: catalog.toolOptions,
    revision: readConfigRevision(payload) ?? '',
    updatedAt: readOptionalNumberOrNull(payload.updatedAt) ?? null,
  };
}

function applyAgentToolConfig(
  config: Record<string, unknown>,
  command: SetAgentToolConfigCommand,
): Record<string, unknown> {
  const agentsSection = readRecord(config.agents);
  const currentAgents = Array.isArray(agentsSection.list) ? agentsSection.list : [];

  const nextAgentList = currentAgents.map((agent) => {
    if (!isRecord(agent)) {
      return agent;
    }
    const agentId = readString(agent.id);
    if (agentId !== command.agentId) {
      return agent;
    }
    if (command.selection.selectionType === 'inheritDefaultTools') {
      const { tools: _tools, ...rest } = agent;
      return rest;
    }
    return {
      ...agent,
      tools: {
        profile: command.selection.profile,
        allow: [...command.selection.allow],
        deny: [...command.selection.deny],
      },
    };
  });

  return {
    ...config,
    agents: {
      ...agentsSection,
      list: nextAgentList,
    },
  };
}

function validateToolPolicySelection(command: SetAgentToolConfigCommand, policyKeys: ReadonlySet<string>): string[] {
  if (command.selection.selectionType === 'inheritDefaultTools') {
    return [];
  }
  return dedupeStrings([...command.selection.allow, ...command.selection.deny]
    .filter((toolKey) => !policyKeys.has(toolKey)));
}

type AgentToolEntry =
  | { readonly entryType: 'agentNotConfigured' }
  | { readonly entryType: 'inheritsDefaultTools' }
  | { readonly entryType: 'usesAgentToolPolicy'; readonly toolPolicy: AgentToolPolicy };

function readAgentToolEntry(config: Record<string, unknown>, agentId: string): AgentToolEntry {
  const agentsSection = readRecord(config.agents);
  if (!Array.isArray(agentsSection.list)) {
    return { entryType: 'agentNotConfigured' };
  }
  for (const agent of agentsSection.list) {
    const agentRecord = readRecord(agent);
    if (readString(agentRecord.id) !== agentId) {
      continue;
    }
    const tools = readAgentToolPolicy(agentRecord.tools);
    return tools ? { entryType: 'usesAgentToolPolicy', toolPolicy: tools } : { entryType: 'inheritsDefaultTools' };
  }
  return { entryType: 'agentNotConfigured' };
}

function readAgentToolPolicy(value: unknown): AgentToolPolicy | null {
  const tools = readRecord(value);
  const profile = readString(tools.profile);
  if (!profile) {
    return null;
  }
  return {
    profile,
    allow: readStringArray(tools.allow),
    deny: readStringArray(tools.deny),
  };
}

function hasConfiguredAgent(config: Record<string, unknown>, agentId: string): boolean {
  const agentsSection = readRecord(config.agents);
  if (!Array.isArray(agentsSection.list)) {
    return false;
  }
  return agentsSection.list.some((agent) => readString(readRecord(agent).id) === agentId);
}

function normalizeToolsCatalogResult(value: unknown, requestedAgentId: string): AgentToolCatalog {
  const catalog = readRecord(value);
  const groups = normalizeToolCatalogGroups(catalog.groups);
  if (groups.length === 0) {
    throw new Error(`tools.catalog returned no tool groups for agent "${requestedAgentId}". Reconnect the OpenClaw runtime and try again.`);
  }
  const toolOptions = buildToolOptions(groups);
  return {
    agentId: readString(catalog.agentId) || requestedAgentId,
    profiles: normalizeToolCatalogProfiles(catalog.profiles),
    groups,
    toolOptions,
    policyKeys: buildKnownToolPolicyKeys(toolOptions, groups),
  };
}

function normalizeToolCatalogProfiles(value: unknown): AgentToolCatalogProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): AgentToolCatalogProfile[] => {
    const profile = readRecord(item);
    const profileKey = readString(profile.id);
    if (!profileKey) {
      return [];
    }
    const displayName = readString(profile.label) || profileKey;
    return [{ profileKey, displayName }];
  });
}

function normalizeToolCatalogGroups(value: unknown): AgentToolConfigGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): AgentToolConfigGroup[] => {
    const group = readRecord(item);
    const groupKey = readString(group.id);
    if (!groupKey) {
      return [];
    }
    const source = readCatalogSource(group.source);
    const pluginId = readString(group.pluginId);
    const displayName = readString(group.label) || pluginId || groupKey;
    const toolOptions = normalizeToolCatalogEntries(group.tools, {
      groupKey,
      groupDisplayName: displayName,
      groupSource: source,
      pluginId,
    });
    return [{
      groupKey,
      displayName,
      source,
      ...(pluginId ? { pluginId } : {}),
      toolOptions,
    }];
  });
}

function normalizeToolCatalogEntries(
  value: unknown,
  group: {
    readonly groupKey: string;
    readonly groupDisplayName: string;
    readonly groupSource: AgentToolCatalogSource;
    readonly pluginId: string;
  },
): AgentToolConfigOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): AgentToolConfigOption[] => {
    const tool = readRecord(item);
    const toolKey = readString(tool.id);
    if (!toolKey) {
      return [];
    }
    const source = readCatalogSource(tool.source, group.groupSource);
    const pluginId = readString(tool.pluginId) || group.pluginId;
    const optional = typeof tool.optional === 'boolean' ? tool.optional : undefined;
    const risk = readCatalogRisk(tool.risk);
    const tags = readStringArray(tool.tags);
    const defaultProfiles = readStringArray(tool.defaultProfiles);
    const description = readString(tool.description);
    return [{
      toolKey,
      displayName: readString(tool.label) || toolKey,
      optionType: 'tool',
      ...(description ? { description } : {}),
      source,
      ...(pluginId ? { pluginId } : {}),
      ...(optional !== undefined ? { optional } : {}),
      ...(risk ? { risk } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(defaultProfiles.length > 0 ? { defaultProfiles } : {}),
      groupKey: group.groupKey,
      groupDisplayName: group.groupDisplayName,
    }];
  });
}

function buildToolOptions(groups: readonly AgentToolConfigGroup[]): AgentToolConfigOption[] {
  const options: AgentToolConfigOption[] = [];
  const hasCoreTools = groups.some((group) => group.source === 'core' && group.toolOptions.length > 0);
  const hasPluginTools = groups.some((group) => group.source === 'plugin' && group.toolOptions.length > 0);
  if (hasCoreTools) {
    options.push({
      toolKey: ALL_OPENCLAW_TOOLS_POLICY_KEY,
      displayName: 'OpenClaw built-in tools',
      optionType: 'group',
      source: 'core',
    });
  }
  if (hasPluginTools) {
    options.push({
      toolKey: ALL_PLUGIN_TOOLS_POLICY_KEY,
      displayName: 'Plugin tools',
      optionType: 'group',
      source: 'plugin',
    });
  }
  for (const group of groups) {
    const policyKey = resolveGroupPolicyKey(group);
    if (policyKey) {
      options.push({
        toolKey: policyKey,
        displayName: `${group.displayName} tools`,
        optionType: 'group',
        source: group.source,
        ...(group.pluginId ? { pluginId: group.pluginId } : {}),
        groupKey: group.groupKey,
        groupDisplayName: group.displayName,
      });
    }
    options.push(...group.toolOptions);
  }
  return dedupeToolOptions(options);
}

function resolveGroupPolicyKey(group: AgentToolConfigGroup): string {
  if (group.source === 'core') {
    return `group:${group.groupKey}`;
  }
  return group.pluginId ?? '';
}

function buildKnownToolPolicyKeys(
  toolOptions: readonly AgentToolConfigOption[],
  groups: readonly AgentToolConfigGroup[],
): ReadonlySet<string> {
  const keys = new Set<string>([ALL_TOOLS_POLICY_KEY]);
  for (const option of toolOptions) {
    keys.add(option.toolKey);
  }
  for (const group of groups) {
    if (group.source === 'plugin' && group.toolOptions.length > 0) {
      keys.add(ALL_PLUGIN_TOOLS_POLICY_KEY);
    }
    for (const tool of group.toolOptions) {
      if (tool.pluginId) {
        keys.add(tool.pluginId);
      }
      const mcpServerPrefix = readMcpServerPrefix(tool.toolKey);
      if (mcpServerPrefix) {
        keys.add(`${mcpServerPrefix}__*`);
      }
    }
  }
  return keys;
}

function readMcpServerPrefix(toolKey: string): string {
  const separatorIndex = toolKey.indexOf('__');
  return separatorIndex > 0 ? toolKey.slice(0, separatorIndex) : '';
}

function dedupeToolOptions(options: readonly AgentToolConfigOption[]): AgentToolConfigOption[] {
  const result: AgentToolConfigOption[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.toolKey)) {
      continue;
    }
    seen.add(option.toolKey);
    result.push(option);
  }
  return result;
}

function readCatalogSource(value: unknown, fallback: AgentToolCatalogSource = 'core'): AgentToolCatalogSource {
  return value === 'plugin' || value === 'core' ? value : fallback;
}

function readCatalogRisk(value: unknown): AgentToolCatalogRisk | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function readConfigRevision(payload: Record<string, unknown>): string | null {
  return readString(payload.revision) || readString(payload.hash) || readString(payload.baseHash) || null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return dedupeStrings(value.flatMap((item) => {
    const stringValue = readString(item);
    return stringValue ? [stringValue] : [];
  }));
}

function dedupeStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}

function readOptionalNumberOrNull(value: unknown): number | null | undefined {
  if (typeof value === 'number') {
    return value;
  }
  return value === null ? null : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
