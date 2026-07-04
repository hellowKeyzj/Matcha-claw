import { create } from 'zustand';
import { hostApiFetch, resolveSingleCapabilityScope } from '@/lib/host-api';
import type { AgentScope, CapabilityTarget } from '../../runtime-host/shared/runtime-address';

const AGENT_TOOL_CONFIG_CAPABILITY_ID = 'agent.tool-config';

export type AgentToolConfigUnsupportedReason = 'runtimeDoesNotExposeAgentToolConfig' | 'agentNotConfigured';

export type AgentToolConfigSupport =
  | { supportType: 'supported' }
  | { supportType: 'unsupported'; reason: AgentToolConfigUnsupportedReason };

export type AgentToolSelectionMode = 'inheritsDefaultTools' | 'usesAgentToolPolicy';
export type AgentToolCatalogSource = 'core' | 'plugin';
export type AgentToolCatalogRisk = 'low' | 'medium' | 'high';

export interface AgentToolPolicy {
  profile: string;
  allow: string[];
  deny: string[];
}

export interface AgentToolCatalogProfile {
  profileKey: string;
  displayName: string;
}

export interface AgentToolConfigOption {
  toolKey: string;
  displayName: string;
  optionType: 'tool' | 'group';
  description?: string;
  source?: AgentToolCatalogSource;
  pluginId?: string;
  optional?: boolean;
  risk?: AgentToolCatalogRisk;
  tags?: string[];
  defaultProfiles?: string[];
  groupKey?: string;
  groupDisplayName?: string;
}

export interface AgentToolConfigGroup {
  groupKey: string;
  displayName: string;
  source: AgentToolCatalogSource;
  pluginId?: string;
  toolOptions: AgentToolConfigOption[];
}

export interface AgentToolConfigView {
  agentId: string;
  support: AgentToolConfigSupport;
  selectionMode: AgentToolSelectionMode;
  toolPolicy: AgentToolPolicy | null;
  toolProfiles: AgentToolCatalogProfile[];
  toolGroups: AgentToolConfigGroup[];
  toolOptions: AgentToolConfigOption[];
  revision: string;
  updatedAt: number | null;
}

export interface SetAgentToolConfigCommand {
  agentId: string;
  revision: string;
  selection:
    | { selectionType: 'inheritDefaultTools' }
    | { selectionType: 'setAgentToolPolicy'; profile: string; allow: string[]; deny: string[] };
}

type SetAgentToolConfigResult =
  | { resultType: 'updated'; view: AgentToolConfigView }
  | { resultType: 'staleRevision'; latestView: AgentToolConfigView }
  | { resultType: 'unsupported'; reason: AgentToolConfigUnsupportedReason }
  | { resultType: 'invalidToolKeys'; unknownToolKeys: string[] };

interface LoadAgentToolConfigOptions {
  force?: boolean;
  silent?: boolean;
}

interface AgentToolConfigState {
  viewByAgentId: Record<string, AgentToolConfigView>;
  loadingByAgentId: Record<string, boolean>;
  errorByAgentId: Record<string, string | null>;
  loadAgentToolConfig: (agentId: string, options?: LoadAgentToolConfigOptions) => Promise<AgentToolConfigView>;
  setAgentToolConfig: (command: SetAgentToolConfigCommand) => Promise<AgentToolConfigView>;
}

const inflightReadByAgentId = new Map<string, Promise<AgentToolConfigView>>();
const viewCacheGenerationByAgentId = new Map<string, number>();

function getViewCacheGeneration(agentId: string): number {
  return viewCacheGenerationByAgentId.get(agentId) ?? 0;
}

function invalidateViewCacheForAgent(agentId: string): void {
  viewCacheGenerationByAgentId.set(agentId, getViewCacheGeneration(agentId) + 1);
}

function getActionableErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

function normalizeAgentId(agentId: string): string {
  return agentId.trim();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim();
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function normalizeSupport(value: unknown): AgentToolConfigSupport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { supportType: 'supported' };
  }
  const supportType = (value as { supportType?: unknown }).supportType;
  if (supportType !== 'unsupported') {
    return { supportType: 'supported' };
  }
  const reason = (value as { reason?: unknown }).reason === 'agentNotConfigured'
    ? 'agentNotConfigured'
    : 'runtimeDoesNotExposeAgentToolConfig';
  return { supportType: 'unsupported', reason };
}

function normalizeToolPolicy(value: unknown): AgentToolPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const profile = typeof record.profile === 'string' && record.profile.trim()
    ? record.profile.trim()
    : 'full';
  return {
    profile,
    allow: normalizeStringArray(record.allow),
    deny: normalizeStringArray(record.deny),
  };
}

function normalizeCatalogSource(value: unknown, fallback: AgentToolCatalogSource = 'core'): AgentToolCatalogSource {
  return value === 'plugin' || value === 'core' ? value : fallback;
}

function normalizeCatalogRisk(value: unknown): AgentToolCatalogRisk | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function normalizeToolCatalogProfile(value: unknown): AgentToolCatalogProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const profileKey = typeof record.profileKey === 'string' && record.profileKey.trim()
    ? record.profileKey.trim()
    : '';
  if (!profileKey) {
    return null;
  }
  const displayName = typeof record.displayName === 'string' && record.displayName.trim()
    ? record.displayName.trim()
    : profileKey;
  return { profileKey, displayName };
}

function normalizeToolConfigOption(value: unknown, group?: { groupKey: string; groupDisplayName: string; source: AgentToolCatalogSource; pluginId?: string }): AgentToolConfigOption | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const toolKey = typeof record.toolKey === 'string' ? record.toolKey.trim() : '';
  if (!toolKey) {
    return null;
  }
  const optionType = record.optionType === 'group' ? 'group' : 'tool';
  const displayName = typeof record.displayName === 'string' && record.displayName.trim() ? record.displayName.trim() : toolKey;
  const description = typeof record.description === 'string' && record.description.trim() ? record.description.trim() : '';
  const source = normalizeCatalogSource(record.source, group?.source ?? 'core');
  const pluginId = typeof record.pluginId === 'string' && record.pluginId.trim()
    ? record.pluginId.trim()
    : group?.pluginId;
  const optional = typeof record.optional === 'boolean' ? record.optional : undefined;
  const risk = normalizeCatalogRisk(record.risk);
  const tags = normalizeStringArray(record.tags);
  const defaultProfiles = normalizeStringArray(record.defaultProfiles);
  const groupKey = typeof record.groupKey === 'string' && record.groupKey.trim()
    ? record.groupKey.trim()
    : group?.groupKey;
  const groupDisplayName = typeof record.groupDisplayName === 'string' && record.groupDisplayName.trim()
    ? record.groupDisplayName.trim()
    : group?.groupDisplayName;
  return {
    toolKey,
    displayName,
    optionType,
    ...(description ? { description } : {}),
    source,
    ...(pluginId ? { pluginId } : {}),
    ...(optional !== undefined ? { optional } : {}),
    ...(risk ? { risk } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(defaultProfiles.length > 0 ? { defaultProfiles } : {}),
    ...(groupKey ? { groupKey } : {}),
    ...(groupDisplayName ? { groupDisplayName } : {}),
  };
}

function normalizeToolConfigGroup(value: unknown): AgentToolConfigGroup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const groupKey = typeof record.groupKey === 'string' && record.groupKey.trim() ? record.groupKey.trim() : '';
  if (!groupKey) {
    return null;
  }
  const source = normalizeCatalogSource(record.source);
  const pluginId = typeof record.pluginId === 'string' && record.pluginId.trim() ? record.pluginId.trim() : undefined;
  const displayName = typeof record.displayName === 'string' && record.displayName.trim()
    ? record.displayName.trim()
    : groupKey;
  const groupContext = {
    groupKey,
    groupDisplayName: displayName,
    source,
    ...(pluginId ? { pluginId } : {}),
  };
  const toolOptions = Array.isArray(record.toolOptions)
    ? record.toolOptions.map((option) => normalizeToolConfigOption(option, groupContext)).filter((option): option is AgentToolConfigOption => option !== null)
    : [];
  return {
    groupKey,
    displayName,
    source,
    ...(pluginId ? { pluginId } : {}),
    toolOptions,
  };
}

function normalizeAgentToolConfigView(payload: unknown, requestedAgentId: string): AgentToolConfigView {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`agent.tool-config returned an invalid view for agent "${requestedAgentId}". Refresh the agent and try again.`);
  }
  const record = payload as Record<string, unknown>;
  const agentId = typeof record.agentId === 'string' && record.agentId.trim()
    ? record.agentId.trim()
    : requestedAgentId;
  const selectionMode = record.selectionMode === 'usesAgentToolPolicy'
    ? 'usesAgentToolPolicy'
    : 'inheritsDefaultTools';
  const toolProfiles = Array.isArray(record.toolProfiles)
    ? record.toolProfiles.map(normalizeToolCatalogProfile).filter((profile): profile is AgentToolCatalogProfile => profile !== null)
    : [];
  const toolGroups = Array.isArray(record.toolGroups)
    ? record.toolGroups.map(normalizeToolConfigGroup).filter((group): group is AgentToolConfigGroup => group !== null)
    : [];
  const toolOptions = Array.isArray(record.toolOptions)
    ? record.toolOptions.map((option) => normalizeToolConfigOption(option)).filter((option): option is AgentToolConfigOption => option !== null)
    : toolGroups.flatMap((group) => group.toolOptions);

  return {
    agentId,
    support: normalizeSupport(record.support),
    selectionMode,
    toolPolicy: normalizeToolPolicy(record.toolPolicy),
    toolProfiles,
    toolGroups,
    toolOptions,
    revision: typeof record.revision === 'string' ? record.revision.trim() : '',
    updatedAt: typeof record.updatedAt === 'number' || record.updatedAt === null ? record.updatedAt : null,
  };
}

function normalizeSetAgentToolConfigCommand(command: SetAgentToolConfigCommand): SetAgentToolConfigCommand {
  const agentId = normalizeAgentId(command.agentId);
  if (!agentId) {
    throw new Error('Agent id is required before updating tool configuration. Select an agent and try again.');
  }
  const revision = command.revision.trim();
  if (!revision) {
    throw new Error('Agent tool configuration must be loaded before updating tools. Refresh the agent and try again.');
  }
  return command.selection.selectionType === 'inheritDefaultTools'
    ? { agentId, revision, selection: { selectionType: 'inheritDefaultTools' } }
    : {
      agentId,
      revision,
      selection: {
        selectionType: 'setAgentToolPolicy',
        profile: command.selection.profile.trim() || 'full',
        allow: normalizeStringArray(command.selection.allow),
        deny: normalizeStringArray(command.selection.deny),
      },
    };
}

async function resolveAgentToolConfigScope(): Promise<AgentScope> {
  const scope = await resolveSingleCapabilityScope(AGENT_TOOL_CONFIG_CAPABILITY_ID);
  if (scope.kind !== 'agent') {
    throw new Error(`agent.tool-config requires agent scope, got ${scope.kind}. Reconnect the runtime and try again.`);
  }
  return scope;
}

function buildAgentToolConfigTarget(scope: AgentScope, agentId: string): CapabilityTarget {
  return {
    kind: 'subagent',
    agentId: scope.agentId,
    subagentId: agentId,
  };
}

async function agentToolConfigCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown>,
  targetAgentId: string,
): Promise<TResult> {
  const scope = await resolveAgentToolConfigScope();
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: AGENT_TOOL_CONFIG_CAPABILITY_ID,
      operationId,
      scope,
      target: buildAgentToolConfigTarget(scope, targetAgentId),
      input,
    }),
  });
}

async function fetchAgentToolConfigView(agentId: string): Promise<AgentToolConfigView> {
  const result = await agentToolConfigCapabilityExecute<unknown>(
    'agentToolConfig.get',
    { agentId },
    agentId,
  );
  return normalizeAgentToolConfigView(result, agentId);
}

async function persistAgentToolConfig(command: SetAgentToolConfigCommand): Promise<AgentToolConfigView> {
  const result = await agentToolConfigCapabilityExecute<SetAgentToolConfigResult>(
    'agentToolConfig.set',
    {
      agentId: command.agentId,
      revision: command.revision,
      selection: command.selection,
    },
    command.agentId,
  );

  switch (result.resultType) {
    case 'updated':
      return normalizeAgentToolConfigView(result.view, command.agentId);
    case 'staleRevision': {
      const latestView = normalizeAgentToolConfigView(result.latestView, command.agentId);
      useAgentToolConfigStore.setState((state) => ({
        viewByAgentId: {
          ...state.viewByAgentId,
          [latestView.agentId]: latestView,
        },
      }));
      throw new Error('Agent tool configuration changed before your update was saved. The latest configuration has been loaded; review it, reapply your tool selection if needed, and save again.');
    }
    case 'invalidToolKeys':
      throw new Error(`Selected tools include keys this runtime cannot save${result.unknownToolKeys.length > 0 ? `: ${result.unknownToolKeys.join(', ')}` : ''}. Refresh the tool list, adjust the selected tools, and try again.`);
    case 'unsupported':
      if (result.reason === 'agentNotConfigured') {
        throw new Error('This runtime has not registered capability settings for this agent yet, so its tools cannot be changed here. Refresh the agent and try again.');
      }
      throw new Error('This runtime does not expose agent tool configuration. Reconnect to a runtime that supports agent.tool-config, then refresh the agent and try again.');
  }
}

export const useAgentToolConfigStore = create<AgentToolConfigState>((set, get) => ({
  viewByAgentId: {},
  loadingByAgentId: {},
  errorByAgentId: {},

  loadAgentToolConfig: async (rawAgentId, options) => {
    const agentId = normalizeAgentId(rawAgentId);
    if (!agentId) {
      throw new Error('Agent id is required before loading tool configuration. Select an agent and try again.');
    }

    const cachedView = get().viewByAgentId[agentId];
    if (cachedView && options?.force !== true) {
      return cachedView;
    }

    const inflightRead = inflightReadByAgentId.get(agentId);
    if (inflightRead) {
      return await inflightRead;
    }

    const readGeneration = getViewCacheGeneration(agentId);

    if (options?.silent !== true) {
      set((state) => ({
        loadingByAgentId: {
          ...state.loadingByAgentId,
          [agentId]: true,
        },
        errorByAgentId: {
          ...state.errorByAgentId,
          [agentId]: null,
        },
      }));
    }

    const readTask = fetchAgentToolConfigView(agentId)
      .then((view) => {
        const shouldUpdateCachedView = getViewCacheGeneration(agentId) === readGeneration;
        set((state) => ({
          viewByAgentId: shouldUpdateCachedView
            ? {
              ...state.viewByAgentId,
              [view.agentId]: view,
            }
            : state.viewByAgentId,
          loadingByAgentId: {
            ...state.loadingByAgentId,
            [agentId]: false,
            [view.agentId]: false,
          },
          errorByAgentId: {
            ...state.errorByAgentId,
            [agentId]: null,
            [view.agentId]: null,
          },
        }));
        return view;
      })
      .catch((error) => {
        const message = getActionableErrorMessage(
          error,
          `Unable to load tool configuration for agent "${agentId}". Refresh the agent and try again.`,
        );
        set((state) => ({
          loadingByAgentId: {
            ...state.loadingByAgentId,
            [agentId]: false,
          },
          errorByAgentId: {
            ...state.errorByAgentId,
            [agentId]: message,
          },
        }));
        throw error;
      })
      .finally(() => {
        if (inflightReadByAgentId.get(agentId) === readTask) {
          inflightReadByAgentId.delete(agentId);
        }
      });

    inflightReadByAgentId.set(agentId, readTask);
    return await readTask;
  },

  setAgentToolConfig: async (rawCommand) => {
    const command = normalizeSetAgentToolConfigCommand(rawCommand);
    invalidateViewCacheForAgent(command.agentId);
    inflightReadByAgentId.delete(command.agentId);
    set((state) => ({
      loadingByAgentId: {
        ...state.loadingByAgentId,
        [command.agentId]: true,
      },
      errorByAgentId: {
        ...state.errorByAgentId,
        [command.agentId]: null,
      },
    }));

    try {
      const view = await persistAgentToolConfig(command);
      set((state) => ({
        viewByAgentId: {
          ...state.viewByAgentId,
          [view.agentId]: view,
        },
        loadingByAgentId: {
          ...state.loadingByAgentId,
          [command.agentId]: false,
          [view.agentId]: false,
        },
        errorByAgentId: {
          ...state.errorByAgentId,
          [command.agentId]: null,
          [view.agentId]: null,
        },
      }));
      return view;
    } catch (error) {
      const message = getActionableErrorMessage(
        error,
        `Unable to update tool configuration for agent "${command.agentId}". Check the selected tools and try again.`,
      );
      set((state) => ({
        loadingByAgentId: {
          ...state.loadingByAgentId,
          [command.agentId]: false,
        },
        errorByAgentId: {
          ...state.errorByAgentId,
          [command.agentId]: message,
        },
      }));
      throw error;
    }
  },
}));

export function __resetAgentToolConfigStoreInternalCachesForTest(): void {
  inflightReadByAgentId.clear();
  viewCacheGenerationByAgentId.clear();
}
