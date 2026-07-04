import type {
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
}

const BUILT_IN_TOOL_OPTIONS: readonly AgentToolConfigOption[] = [
  { toolKey: 'read', displayName: 'Read', optionType: 'tool' },
  { toolKey: 'write', displayName: 'Write', optionType: 'tool' },
  { toolKey: 'edit', displayName: 'Edit', optionType: 'tool' },
  { toolKey: 'apply_patch', displayName: 'Apply Patch', optionType: 'tool' },
  { toolKey: 'exec', displayName: 'Exec', optionType: 'tool' },
  { toolKey: 'process', displayName: 'Process', optionType: 'tool' },
  { toolKey: 'code_execution', displayName: 'Code Execution', optionType: 'tool' },
  { toolKey: 'sessions_list', displayName: 'Sessions List', optionType: 'tool' },
  { toolKey: 'sessions_history', displayName: 'Sessions History', optionType: 'tool' },
  { toolKey: 'sessions_send', displayName: 'Sessions Send', optionType: 'tool' },
  { toolKey: 'sessions_spawn', displayName: 'Sessions Spawn', optionType: 'tool' },
  { toolKey: 'sessions_yield', displayName: 'Sessions Yield', optionType: 'tool' },
  { toolKey: 'subagents', displayName: 'Subagents', optionType: 'tool' },
  { toolKey: 'session_status', displayName: 'Session Status', optionType: 'tool' },
  { toolKey: 'memory_search', displayName: 'Memory Search', optionType: 'tool' },
  { toolKey: 'memory_get', displayName: 'Memory Get', optionType: 'tool' },
  { toolKey: 'web_search', displayName: 'Web Search', optionType: 'tool' },
  { toolKey: 'x_search', displayName: 'X Search', optionType: 'tool' },
  { toolKey: 'web_fetch', displayName: 'Web Fetch', optionType: 'tool' },
  { toolKey: 'browser', displayName: 'Browser', optionType: 'tool' },
  { toolKey: 'canvas', displayName: 'Canvas', optionType: 'tool' },
  { toolKey: 'heartbeat_respond', displayName: 'Heartbeat Respond', optionType: 'tool' },
  { toolKey: 'cron', displayName: 'Cron', optionType: 'tool' },
  { toolKey: 'gateway', displayName: 'Gateway', optionType: 'tool' },
  { toolKey: 'message', displayName: 'Message', optionType: 'tool' },
  { toolKey: 'nodes', displayName: 'Nodes', optionType: 'tool' },
  { toolKey: 'agents_list', displayName: 'Agents List', optionType: 'tool' },
  { toolKey: 'update_plan', displayName: 'Update Plan', optionType: 'tool' },
  { toolKey: 'image', displayName: 'Image', optionType: 'tool' },
  { toolKey: 'image_generate', displayName: 'Image Generate', optionType: 'tool' },
  { toolKey: 'music_generate', displayName: 'Music Generate', optionType: 'tool' },
  { toolKey: 'video_generate', displayName: 'Video Generate', optionType: 'tool' },
  { toolKey: 'tts', displayName: 'Text to Speech', optionType: 'tool' },
  { toolKey: 'group:*', displayName: 'All tool groups', optionType: 'group' },
  { toolKey: 'group:runtime', displayName: 'Runtime tools', optionType: 'group' },
  { toolKey: 'group:fs', displayName: 'Filesystem tools', optionType: 'group' },
  { toolKey: 'group:sessions', displayName: 'Session tools', optionType: 'group' },
  { toolKey: 'group:memory', displayName: 'Memory tools', optionType: 'group' },
  { toolKey: 'group:web', displayName: 'Web tools', optionType: 'group' },
  { toolKey: 'group:ui', displayName: 'UI tools', optionType: 'group' },
  { toolKey: 'group:automation', displayName: 'Automation tools', optionType: 'group' },
  { toolKey: 'group:messaging', displayName: 'Messaging tools', optionType: 'group' },
  { toolKey: 'group:nodes', displayName: 'Node tools', optionType: 'group' },
  { toolKey: 'group:agents', displayName: 'Agent tools', optionType: 'group' },
  { toolKey: 'group:media', displayName: 'Media tools', optionType: 'group' },
  { toolKey: 'group:openclaw', displayName: 'OpenClaw built-in tools', optionType: 'group' },
] as const;

const BUILT_IN_TOOL_KEYS = new Set(BUILT_IN_TOOL_OPTIONS.map((option) => option.toolKey));

export class OpenClawAgentToolConfigProjection implements AgentToolConfigProjectionPort {
  constructor(private readonly deps: OpenClawAgentToolConfigProjectionDeps) {}

  async readAgentToolConfig(agentId: string): Promise<AgentToolConfigView> {
    const snapshot = await this.deps.subagentConfigProjection.readConfig();
    if (!hasConfiguredAgent(snapshot.config, agentId)) {
      return agentNotConfiguredToolConfigView(agentId, toConfigPayload(snapshot));
    }
    return buildView(agentId, toConfigPayload(snapshot));
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
      return {
        resultType: 'staleRevision',
        latestView: buildView(command.agentId, payload),
      };
    }

    if (!hasConfiguredAgent(currentConfig, command.agentId)) {
      return { resultType: 'unsupported', reason: 'agentNotConfigured' };
    }

    const invalidToolKeys = validateToolPolicySelection(command);
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
      return {
        resultType: 'staleRevision',
        latestView: buildView(command.agentId, latestPayload),
      };
    }

    const nextPayload = toConfigPayload(replaceResult.snapshot);
    return {
      resultType: 'updated',
      view: buildView(command.agentId, nextPayload),
    };
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
    toolOptions: [],
    revision: readConfigRevision(payload) ?? '',
    updatedAt: readOptionalNumberOrNull(payload.updatedAt) ?? null,
  };
}

function buildView(agentId: string, payload: Record<string, unknown>): AgentToolConfigView {
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
    toolOptions: [...BUILT_IN_TOOL_OPTIONS],
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

function validateToolPolicySelection(command: SetAgentToolConfigCommand): string[] {
  if (command.selection.selectionType === 'inheritDefaultTools') {
    return [];
  }
  return dedupeStrings([...command.selection.allow, ...command.selection.deny]
    .filter((toolKey) => !BUILT_IN_TOOL_KEYS.has(toolKey)));
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
