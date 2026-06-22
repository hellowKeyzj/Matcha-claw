import type {
  AgentSkillConfigOption,
  AgentSkillConfigProjectionPort,
  AgentSkillConfigView,
  AgentSkillMissingRequirements,
  SetAgentSkillConfigCommand,
  SetAgentSkillConfigResult,
} from '../../../subagents/agent-skill-config-contracts';
import type { SubagentRuntimeWorkflow } from '../../../workflows/subagent-runtime/subagent-runtime-workflow';
import type { SkillRuntimeWorkflow } from '../../../workflows/skill-runtime/skill-runtime-workflow';

interface OpenClawAgentSkillConfigProjectionDeps {
  readonly runtimeWorkflow: Pick<SubagentRuntimeWorkflow, 'call'>;
  readonly skillRuntimeWorkflow: Pick<SkillRuntimeWorkflow, 'refreshStatus' | 'resolveCanonicalSkillKeyMap' | 'validateCanonicalSkillKeys'>;
}

export class OpenClawAgentSkillConfigProjection implements AgentSkillConfigProjectionPort {
  constructor(private readonly deps: OpenClawAgentSkillConfigProjectionDeps) {}

  async readAgentSkillConfig(agentId: string): Promise<AgentSkillConfigView> {
    const configResponse = await this.deps.runtimeWorkflow.call('config.get', {});
    if (configResponse.status !== 200) {
      return unsupportedAgentSkillConfigView(agentId);
    }
    const payload = readRecord(configResponse.data);
    const config = readRecord(payload.config);
    if (!hasConfiguredAgent(config, agentId)) {
      return agentNotConfiguredSkillConfigView(agentId, payload);
    }
    const skillStatus = await this.deps.skillRuntimeWorkflow.refreshStatus();
    return await this.buildView(agentId, payload, skillStatus);
  }

  async setAgentSkillConfig(command: SetAgentSkillConfigCommand): Promise<SetAgentSkillConfigResult> {
    const configResponse = await this.deps.runtimeWorkflow.call('config.get', {});
    if (configResponse.status !== 200) {
      return { resultType: 'unsupported', reason: 'runtimeDoesNotExposeAgentSkillConfig' };
    }

    const payload = readRecord(configResponse.data);
    const currentConfig = readRecord(payload.config);
    const currentRevision = readConfigRevision(payload);
    if (!currentRevision || currentRevision !== command.revision) {
      if (!hasConfiguredAgent(currentConfig, command.agentId)) {
        return {
          resultType: 'staleRevision',
          latestView: agentNotConfiguredSkillConfigView(command.agentId, payload),
        };
      }
      const skillStatus = await this.deps.skillRuntimeWorkflow.refreshStatus();
      return {
        resultType: 'staleRevision',
        latestView: await this.buildView(command.agentId, payload, skillStatus),
      };
    }

    if (!hasConfiguredAgent(currentConfig, command.agentId)) {
      return { resultType: 'unsupported', reason: 'agentNotConfigured' };
    }

    const validation = await this.validateCommand(command);
    if (validation.resultType === 'invalidSkillKeys') {
      return validation;
    }

    let skillStatus: unknown | null = null;
    if (validation.command.selection.selectionType === 'setExplicitSkillAllowlist') {
      skillStatus = await this.deps.skillRuntimeWorkflow.refreshStatus();
      const selectableValidation = validateSelectableSkillKeys(validation.command, skillStatus);
      if (selectableValidation.resultType === 'invalidSkillKeys') {
        return selectableValidation;
      }
    }

    const nextConfig = applyAgentSkillConfig(currentConfig, validation.command);
    const setResponse = await this.deps.runtimeWorkflow.call('config.set', {
      raw: JSON.stringify(nextConfig),
      baseHash: command.revision,
    }, { invalidateSnapshots: true });
    if (setResponse.status !== 200) {
      return { resultType: 'unsupported', reason: 'runtimeDoesNotExposeAgentSkillConfig' };
    }

    const setPayload = readRecord(setResponse.data);
    const nextPayload = {
      ...payload,
      ...setPayload,
      config: Object.hasOwn(setPayload, 'config') ? readRecord(setPayload.config) : nextConfig,
    };
    return {
      resultType: 'updated',
      view: await this.buildView(command.agentId, nextPayload, skillStatus ?? await this.deps.skillRuntimeWorkflow.refreshStatus()),
    };
  }

  private async buildView(agentId: string, payload: Record<string, unknown>, skillStatus: unknown): Promise<AgentSkillConfigView> {
    const config = readRecord(payload.config);
    const configuredSkillKeys = collectConfiguredSkillKeys(config);
    const canonicalSkillKeyByInput = await this.deps.skillRuntimeWorkflow.resolveCanonicalSkillKeyMap(configuredSkillKeys);
    const options = readSkillOptions(skillStatus);
    const revision = readConfigRevision(payload) ?? '';
    const updatedAt = readOptionalNumberOrNull(payload.updatedAt) ?? null;
    const agentSkillEntry = readAgentSkillEntry(config, agentId, canonicalSkillKeyByInput);
    if (agentSkillEntry.entryType === 'agentNotConfigured') {
      return {
        agentId,
        support: { supportType: 'unsupported', reason: 'agentNotConfigured' },
        selectionMode: 'inheritsDefaultSkills',
        explicitSkillKeys: [],
        inheritedDefaultSkillKeys: [],
        effectiveSkillKeys: [],
        options: [],
        revision,
        updatedAt,
      };
    }

    const inheritedDefaultSkillKeys = resolveInheritedDefaultSkillKeys(config, options, canonicalSkillKeyByInput);
    const selectionMode = agentSkillEntry.entryType === 'inheritsDefaultSkills'
      ? 'inheritsDefaultSkills'
      : 'usesExplicitSkillAllowlist';
    const explicitSkillKeys = agentSkillEntry.entryType === 'usesExplicitSkillAllowlist'
      ? agentSkillEntry.skillKeys
      : [];
    const effectiveSkillKeys = agentSkillEntry.entryType === 'usesExplicitSkillAllowlist'
      ? agentSkillEntry.skillKeys
      : inheritedDefaultSkillKeys;

    return {
      agentId,
      support: { supportType: 'supported' },
      selectionMode,
      explicitSkillKeys,
      inheritedDefaultSkillKeys,
      effectiveSkillKeys,
      options,
      revision,
      updatedAt,
    };
  }

  private async validateCommand(command: SetAgentSkillConfigCommand): Promise<
    | { resultType: 'validCommand'; command: SetAgentSkillConfigCommand }
    | Extract<SetAgentSkillConfigResult, { resultType: 'invalidSkillKeys' }>
  > {
    if (command.selection.selectionType === 'inheritDefaultSkills') {
      return { resultType: 'validCommand', command };
    }

    const validation = await this.deps.skillRuntimeWorkflow.validateCanonicalSkillKeys(command.selection.skillKeys);
    if (!validation.ok) {
      return {
        resultType: 'invalidSkillKeys',
        unknownSkillKeys: validation.unknownSkillKeys,
        nonCanonicalSkillKeys: validation.nonCanonicalSkillKeys,
      };
    }

    return {
      resultType: 'validCommand',
      command: {
        ...command,
        selection: {
          selectionType: 'setExplicitSkillAllowlist',
          skillKeys: validation.skillKeys,
        },
      },
    };
  }
}

function unsupportedAgentSkillConfigView(agentId: string): AgentSkillConfigView {
  return {
    agentId,
    support: { supportType: 'unsupported', reason: 'runtimeDoesNotExposeAgentSkillConfig' },
    selectionMode: 'inheritsDefaultSkills',
    explicitSkillKeys: [],
    inheritedDefaultSkillKeys: [],
    effectiveSkillKeys: [],
    options: [],
    revision: '',
    updatedAt: null,
  };
}

function agentNotConfiguredSkillConfigView(agentId: string, payload: Record<string, unknown>): AgentSkillConfigView {
  return {
    agentId,
    support: { supportType: 'unsupported', reason: 'agentNotConfigured' },
    selectionMode: 'inheritsDefaultSkills',
    explicitSkillKeys: [],
    inheritedDefaultSkillKeys: [],
    effectiveSkillKeys: [],
    options: [],
    revision: readConfigRevision(payload) ?? '',
    updatedAt: readOptionalNumberOrNull(payload.updatedAt) ?? null,
  };
}

function validateSelectableSkillKeys(
  command: SetAgentSkillConfigCommand,
  skillStatus: unknown,
): { resultType: 'validSelectableSkillKeys' } | Extract<SetAgentSkillConfigResult, { resultType: 'invalidSkillKeys' }> {
  if (command.selection.selectionType === 'inheritDefaultSkills') {
    return { resultType: 'validSelectableSkillKeys' };
  }

  const selectableSkillKeys = new Set(readSkillOptions(skillStatus)
    .filter((option) => option.selectable)
    .map((option) => option.skillKey));
  const unselectableSkillKeys = command.selection.skillKeys.filter((skillKey) => !selectableSkillKeys.has(skillKey));
  if (unselectableSkillKeys.length === 0) {
    return { resultType: 'validSelectableSkillKeys' };
  }
  return {
    resultType: 'invalidSkillKeys',
    unknownSkillKeys: dedupeStrings(unselectableSkillKeys),
    nonCanonicalSkillKeys: [],
  };
}

function applyAgentSkillConfig(
  config: Record<string, unknown>,
  command: SetAgentSkillConfigCommand,
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
    if (command.selection.selectionType === 'inheritDefaultSkills') {
      const { skills: _skills, ...rest } = agent;
      return rest;
    }
    return {
      ...agent,
      skills: [...command.selection.skillKeys],
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

function readSkillOptions(statusPayload: unknown): AgentSkillConfigOption[] {
  const status = readRecord(statusPayload);
  if (!Array.isArray(status.skills)) {
    return [];
  }
  return status.skills.flatMap((skill): AgentSkillConfigOption[] => {
    const skillRecord = readRecord(skill);
    const skillKey = readString(skillRecord.skillKey);
    if (!skillKey) {
      return [];
    }
    const missingRequirements = readMissingRequirements(skillRecord.missing);
    const unavailableReason = resolveUnavailableReason(skillRecord, missingRequirements);
    const installed = skillRecord.installed === true;
    return [{
      skillKey,
      displayName: readString(skillRecord.name) || skillKey,
      description: readString(skillRecord.description),
      installed,
      selectable: installed && unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(missingRequirements ? { missingRequirements } : {}),
    }];
  });
}

function resolveUnavailableReason(
  skill: Record<string, unknown>,
  missingRequirements: AgentSkillMissingRequirements | undefined,
): AgentSkillConfigOption['unavailableReason'] {
  if (skill.disabled === true) {
    return 'globalSkillDisabled';
  }
  if (skill.blockedByAllowlist === true) {
    return 'blockedByRuntimeAllowlist';
  }
  if (missingRequirements) {
    return 'missingRequirements';
  }
  return undefined;
}

function readMissingRequirements(value: unknown): AgentSkillMissingRequirements | undefined {
  const missing = readRecord(value);
  const result: AgentSkillMissingRequirements = {
    bins: readStringArray(missing.bins),
    anyBins: readStringArray(missing.anyBins),
    env: readStringArray(missing.env),
    config: readStringArray(missing.config),
    os: readStringArray(missing.os),
  };
  return Object.values(result).some((items) => items.length > 0) ? result : undefined;
}

function collectConfiguredSkillKeys(config: Record<string, unknown>): string[] {
  const skillKeys = [...readDefaultSkillKeys(config)];
  const agentsSection = readRecord(config.agents);
  if (Array.isArray(agentsSection.list)) {
    for (const agent of agentsSection.list) {
      skillKeys.push(...readStringArray(readRecord(agent).skills));
    }
  }
  return dedupeStrings(skillKeys);
}

function readDefaultSkillKeys(config: Record<string, unknown>): string[] {
  const agentsSection = readRecord(config.agents);
  const defaultsSection = readRecord(agentsSection.defaults);
  return readStringArray(defaultsSection.skills);
}

function resolveInheritedDefaultSkillKeys(
  config: Record<string, unknown>,
  options: readonly AgentSkillConfigOption[],
  canonicalSkillKeyByInput: Record<string, string>,
): string[] {
  const configuredDefaultSkillKeys = readDefaultSkillKeys(config);
  if (configuredDefaultSkillKeys.length > 0) {
    return canonicalizeSkillKeys(configuredDefaultSkillKeys, canonicalSkillKeyByInput);
  }
  return options
    .filter((option) => option.selectable)
    .map((option) => option.skillKey);
}

type AgentSkillEntry =
  | { readonly entryType: 'agentNotConfigured' }
  | { readonly entryType: 'inheritsDefaultSkills' }
  | { readonly entryType: 'usesExplicitSkillAllowlist'; readonly skillKeys: string[] };

function readAgentSkillEntry(
  config: Record<string, unknown>,
  agentId: string,
  canonicalSkillKeyByInput: Record<string, string>,
): AgentSkillEntry {
  const agentsSection = readRecord(config.agents);
  if (!Array.isArray(agentsSection.list)) {
    return { entryType: 'agentNotConfigured' };
  }
  for (const agent of agentsSection.list) {
    const agentRecord = readRecord(agent);
    if (readString(agentRecord.id) !== agentId) {
      continue;
    }
    if (!Array.isArray(agentRecord.skills)) {
      return { entryType: 'inheritsDefaultSkills' };
    }
    return {
      entryType: 'usesExplicitSkillAllowlist',
      skillKeys: canonicalizeSkillKeys(readStringArray(agentRecord.skills), canonicalSkillKeyByInput),
    };
  }
  return { entryType: 'agentNotConfigured' };
}

function hasConfiguredAgent(config: Record<string, unknown>, agentId: string): boolean {
  const agentsSection = readRecord(config.agents);
  if (!Array.isArray(agentsSection.list)) {
    return false;
  }
  return agentsSection.list.some((agent) => readString(readRecord(agent).id) === agentId);
}

function canonicalizeSkillKeys(skillKeys: readonly string[], canonicalSkillKeyByInput: Record<string, string>): string[] {
  return dedupeStrings(skillKeys.map((skillKey) => canonicalSkillKeyByInput[skillKey] ?? skillKey));
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
