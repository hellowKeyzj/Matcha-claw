import { create } from 'zustand';
import { hostApiFetch, resolveSingleCapabilityScope } from '@/lib/host-api';
import type { AgentScope, CapabilityTarget } from '../../runtime-host/shared/runtime-address';

const AGENT_SKILL_CONFIG_CAPABILITY_ID = 'agent.skill-config';

export type AgentSkillConfigUnsupportedReason = 'runtimeDoesNotExposeAgentSkillConfig' | 'agentNotConfigured';

export type AgentSkillConfigSupport =
  | { supportType: 'supported' }
  | { supportType: 'unsupported'; reason: AgentSkillConfigUnsupportedReason };

export type AgentSkillSelectionMode = 'inheritsDefaultSkills' | 'usesExplicitSkillAllowlist';

export interface AgentSkillMissingRequirements {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

export interface AgentSkillConfigOption {
  skillKey: string;
  displayName: string;
  description: string;
  installed: boolean;
  selectable: boolean;
  unavailableReason?: 'globalSkillDisabled' | 'blockedByRuntimeAllowlist' | 'missingRequirements';
  missingRequirements?: AgentSkillMissingRequirements;
}

export interface AgentSkillConfigView {
  agentId: string;
  support: AgentSkillConfigSupport;
  selectionMode: AgentSkillSelectionMode;
  explicitSkillKeys: string[];
  inheritedDefaultSkillKeys: string[];
  effectiveSkillKeys: string[];
  options: AgentSkillConfigOption[];
  revision: string;
  updatedAt: number | null;
}

export interface SetAgentSkillConfigCommand {
  agentId: string;
  revision: string;
  selection:
    | { selectionType: 'inheritDefaultSkills' }
    | { selectionType: 'setExplicitSkillAllowlist'; skillKeys: string[] };
}

type SetAgentSkillConfigResult =
  | { resultType: 'updated'; view: AgentSkillConfigView }
  | { resultType: 'staleRevision'; latestView: AgentSkillConfigView }
  | { resultType: 'unsupported'; reason: AgentSkillConfigUnsupportedReason }
  | { resultType: 'invalidSkillKeys'; unknownSkillKeys: string[]; nonCanonicalSkillKeys: string[] };

interface LoadAgentSkillConfigOptions {
  force?: boolean;
  silent?: boolean;
}

interface AgentSkillConfigState {
  viewByAgentId: Record<string, AgentSkillConfigView>;
  loadingByAgentId: Record<string, boolean>;
  errorByAgentId: Record<string, string | null>;
  loadAgentSkillConfig: (agentId: string, options?: LoadAgentSkillConfigOptions) => Promise<AgentSkillConfigView>;
  setAgentSkillConfig: (command: SetAgentSkillConfigCommand) => Promise<AgentSkillConfigView>;
}

const inflightReadByAgentId = new Map<string, Promise<AgentSkillConfigView>>();
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

function normalizeMissingRequirements(value: unknown): AgentSkillMissingRequirements | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const missing: AgentSkillMissingRequirements = {
    bins: normalizeStringArray(record.bins),
    anyBins: normalizeStringArray(record.anyBins),
    env: normalizeStringArray(record.env),
    config: normalizeStringArray(record.config),
    os: normalizeStringArray(record.os),
  };
  return Object.values(missing).some((items) => items.length > 0) ? missing : undefined;
}

function normalizeSkillConfigOption(value: unknown): AgentSkillConfigOption | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const skillKey = typeof record.skillKey === 'string' ? record.skillKey.trim() : '';
  if (!skillKey) {
    return null;
  }
  const missingRequirements = normalizeMissingRequirements(record.missingRequirements);
  const unavailableReason = typeof record.unavailableReason === 'string'
    && ['globalSkillDisabled', 'blockedByRuntimeAllowlist', 'missingRequirements'].includes(record.unavailableReason)
    ? record.unavailableReason as AgentSkillConfigOption['unavailableReason']
    : undefined;
  const isInstalled = record.installed === true;
  const isSelectableWhenInstalled = typeof record.selectable === 'boolean' ? record.selectable : true;
  return {
    skillKey,
    displayName: typeof record.displayName === 'string' && record.displayName.trim() ? record.displayName : skillKey,
    description: typeof record.description === 'string' ? record.description : '',
    installed: isInstalled,
    selectable: isInstalled && isSelectableWhenInstalled,
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(missingRequirements ? { missingRequirements } : {}),
  };
}

function normalizeSupport(value: unknown): AgentSkillConfigSupport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { supportType: 'supported' };
  }
  const supportType = (value as { supportType?: unknown }).supportType;
  if (supportType !== 'unsupported') {
    return { supportType: 'supported' };
  }
  const reason = (value as { reason?: unknown }).reason === 'agentNotConfigured'
    ? 'agentNotConfigured'
    : 'runtimeDoesNotExposeAgentSkillConfig';
  return { supportType: 'unsupported', reason };
}

function normalizeAgentSkillConfigView(payload: unknown, requestedAgentId: string): AgentSkillConfigView {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`agent.skill-config returned an invalid view for agent "${requestedAgentId}". Refresh the agent and try again.`);
  }
  const record = payload as Record<string, unknown>;
  const agentId = typeof record.agentId === 'string' && record.agentId.trim()
    ? record.agentId.trim()
    : requestedAgentId;
  const selectionMode = record.selectionMode === 'usesExplicitSkillAllowlist'
    ? 'usesExplicitSkillAllowlist'
    : 'inheritsDefaultSkills';
  const options = Array.isArray(record.options)
    ? record.options.map(normalizeSkillConfigOption).filter((option): option is AgentSkillConfigOption => option !== null)
    : [];

  return {
    agentId,
    support: normalizeSupport(record.support),
    selectionMode,
    explicitSkillKeys: normalizeStringArray(record.explicitSkillKeys),
    inheritedDefaultSkillKeys: normalizeStringArray(record.inheritedDefaultSkillKeys),
    effectiveSkillKeys: normalizeStringArray(record.effectiveSkillKeys),
    options,
    revision: typeof record.revision === 'string' ? record.revision.trim() : '',
    updatedAt: typeof record.updatedAt === 'number' || record.updatedAt === null ? record.updatedAt : null,
  };
}

function normalizeSetAgentSkillConfigCommand(command: SetAgentSkillConfigCommand): SetAgentSkillConfigCommand {
  const agentId = normalizeAgentId(command.agentId);
  if (!agentId) {
    throw new Error('Agent id is required before updating skill configuration. Select an agent and try again.');
  }
  const revision = command.revision.trim();
  if (!revision) {
    throw new Error('Agent skill configuration must be loaded before updating skills. Refresh the agent and try again.');
  }
  return command.selection.selectionType === 'inheritDefaultSkills'
    ? { agentId, revision, selection: { selectionType: 'inheritDefaultSkills' } }
    : {
      agentId,
      revision,
      selection: {
        selectionType: 'setExplicitSkillAllowlist',
        skillKeys: normalizeStringArray(command.selection.skillKeys),
      },
    };
}

async function resolveAgentSkillConfigScope(): Promise<AgentScope> {
  const scope = await resolveSingleCapabilityScope(AGENT_SKILL_CONFIG_CAPABILITY_ID);
  if (scope.kind !== 'agent') {
    throw new Error(`agent.skill-config requires agent scope, got ${scope.kind}. Reconnect the runtime and try again.`);
  }
  return scope;
}

function buildAgentSkillConfigTarget(scope: AgentScope, agentId: string): CapabilityTarget {
  return {
    kind: 'subagent',
    agentId: scope.agentId,
    subagentId: agentId,
  };
}

async function agentSkillConfigCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown>,
  targetAgentId: string,
): Promise<TResult> {
  const scope = await resolveAgentSkillConfigScope();
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: AGENT_SKILL_CONFIG_CAPABILITY_ID,
      operationId,
      scope,
      target: buildAgentSkillConfigTarget(scope, targetAgentId),
      input,
    }),
  });
}

async function fetchAgentSkillConfigView(agentId: string): Promise<AgentSkillConfigView> {
  const result = await agentSkillConfigCapabilityExecute<unknown>(
    'agentSkillConfig.get',
    { agentId },
    agentId,
  );
  return normalizeAgentSkillConfigView(result, agentId);
}

async function persistAgentSkillConfig(command: SetAgentSkillConfigCommand): Promise<AgentSkillConfigView> {
  const result = await agentSkillConfigCapabilityExecute<SetAgentSkillConfigResult>(
    'agentSkillConfig.set',
    {
      agentId: command.agentId,
      revision: command.revision,
      selection: command.selection,
    },
    command.agentId,
  );

  switch (result.resultType) {
    case 'updated':
      return normalizeAgentSkillConfigView(result.view, command.agentId);
    case 'staleRevision': {
      const latestView = normalizeAgentSkillConfigView(result.latestView, command.agentId);
      useAgentSkillConfigStore.setState((state) => ({
        viewByAgentId: {
          ...state.viewByAgentId,
          [latestView.agentId]: latestView,
        },
      }));
      throw new Error('Agent skill configuration changed before your update was saved. The latest configuration has been loaded; review it, reapply your skill selection if needed, and save again.');
    }
    case 'invalidSkillKeys': {
      const details = [
        result.unknownSkillKeys.length > 0 ? `unknown: ${result.unknownSkillKeys.join(', ')}` : '',
        result.nonCanonicalSkillKeys.length > 0 ? `non-canonical: ${result.nonCanonicalSkillKeys.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      throw new Error(`Selected skills include keys this runtime cannot save${details ? ` (${details})` : ''}. Refresh the skill list, adjust the selected skills, and try again.`);
    }
    case 'unsupported':
      if (result.reason === 'agentNotConfigured') {
        throw new Error('This runtime has not registered capability settings for this agent yet, so its skills cannot be changed here. Refresh the agent and try again.');
      }
      throw new Error('This runtime does not expose agent skill configuration. Reconnect to a runtime that supports agent.skill-config, then refresh the agent and try again.');
  }
}

export const useAgentSkillConfigStore = create<AgentSkillConfigState>((set, get) => ({
  viewByAgentId: {},
  loadingByAgentId: {},
  errorByAgentId: {},

  loadAgentSkillConfig: async (rawAgentId, options) => {
    const agentId = normalizeAgentId(rawAgentId);
    if (!agentId) {
      throw new Error('Agent id is required before loading skill configuration. Select an agent and try again.');
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

    const readTask = fetchAgentSkillConfigView(agentId)
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
          `Unable to load skill configuration for agent "${agentId}". Refresh the agent and try again.`,
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

  setAgentSkillConfig: async (rawCommand) => {
    const command = normalizeSetAgentSkillConfigCommand(rawCommand);
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
      const view = await persistAgentSkillConfig(command);
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
        `Unable to update skill configuration for agent "${command.agentId}". Check the selected skills and try again.`,
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

export function __resetAgentSkillConfigStoreInternalCachesForTest(): void {
  inflightReadByAgentId.clear();
  viewCacheGenerationByAgentId.clear();
}
