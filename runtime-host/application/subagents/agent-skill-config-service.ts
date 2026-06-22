import { badRequest, ok, type ApplicationResponseOf } from '../common/application-response';
import type {
  AgentSkillConfigProjectionPort,
  AgentSkillConfigView,
  SetAgentSkillConfigCommand,
  SetAgentSkillConfigResult,
} from './agent-skill-config-contracts';

type AgentSkillConfigFailure = { readonly success: false; readonly error: string };

type ReadAgentSkillConfigCommandResult =
  | { readonly resultType: 'validReadAgentSkillConfigCommand'; readonly agentId: string }
  | { readonly resultType: 'invalidReadAgentSkillConfigCommand'; readonly error: string };

type SetAgentSkillConfigCommandResult =
  | { readonly resultType: 'validSetAgentSkillConfigCommand'; readonly command: SetAgentSkillConfigCommand }
  | { readonly resultType: 'invalidSetAgentSkillConfigCommand'; readonly error: string };

type StringListValidationResult =
  | { readonly resultType: 'validStringList'; readonly values: string[] }
  | { readonly resultType: 'invalidStringList'; readonly error: string };

export class AgentSkillConfigService {
  constructor(private readonly deps: {
    readonly projection: AgentSkillConfigProjectionPort;
  }) {}

  async getConfig(payload: unknown): Promise<ApplicationResponseOf<AgentSkillConfigView | AgentSkillConfigFailure>> {
    const command = readAgentSkillConfigCommand(payload);
    if (command.resultType === 'invalidReadAgentSkillConfigCommand') {
      return badRequest(command.error);
    }
    return ok(await this.deps.projection.readAgentSkillConfig(command.agentId));
  }

  async setConfig(payload: unknown): Promise<ApplicationResponseOf<SetAgentSkillConfigResult | AgentSkillConfigFailure>> {
    const command = readSetAgentSkillConfigCommand(payload);
    if (command.resultType === 'invalidSetAgentSkillConfigCommand') {
      return badRequest(command.error);
    }

    return ok(await this.deps.projection.setAgentSkillConfig(command.command));
  }
}

function readAgentSkillConfigCommand(payload: unknown): ReadAgentSkillConfigCommandResult {
  const record = readRecord(payload);
  const agentId = readTrimmedString(record.agentId) || readTrimmedString(record.subagentId);
  if (!agentId) {
    return { resultType: 'invalidReadAgentSkillConfigCommand', error: 'agentId is required' };
  }
  if (!isSafeAgentId(agentId)) {
    return { resultType: 'invalidReadAgentSkillConfigCommand', error: 'agentId is invalid' };
  }
  return { resultType: 'validReadAgentSkillConfigCommand', agentId };
}

function readSetAgentSkillConfigCommand(payload: unknown): SetAgentSkillConfigCommandResult {
  const record = readRecord(payload);
  const agentId = readTrimmedString(record.agentId) || readTrimmedString(record.subagentId);
  if (!agentId) {
    return { resultType: 'invalidSetAgentSkillConfigCommand', error: 'agentId is required' };
  }
  if (!isSafeAgentId(agentId)) {
    return { resultType: 'invalidSetAgentSkillConfigCommand', error: 'agentId is invalid' };
  }

  const revision = readTrimmedString(record.revision);
  if (!revision) {
    return { resultType: 'invalidSetAgentSkillConfigCommand', error: 'revision is required' };
  }

  const selection = readRecord(record.selection);
  const selectionType = readTrimmedString(selection.selectionType);
  if (selectionType === 'inheritDefaultSkills') {
    return {
      resultType: 'validSetAgentSkillConfigCommand',
      command: {
        agentId,
        revision,
        selection: { selectionType: 'inheritDefaultSkills' },
      },
    };
  }
  if (selectionType !== 'setExplicitSkillAllowlist') {
    return { resultType: 'invalidSetAgentSkillConfigCommand', error: 'selection.selectionType is required' };
  }

  const skillKeys = readRequiredStringList(selection.skillKeys, 'selection.skillKeys');
  if (skillKeys.resultType === 'invalidStringList') {
    return { resultType: 'invalidSetAgentSkillConfigCommand', error: skillKeys.error };
  }

  return {
    resultType: 'validSetAgentSkillConfigCommand',
    command: {
      agentId,
      revision,
      selection: {
        selectionType: 'setExplicitSkillAllowlist',
        skillKeys: skillKeys.values,
      },
    },
  };
}

function readRequiredStringList(value: unknown, fieldName: string): StringListValidationResult {
  if (!Array.isArray(value)) {
    return { resultType: 'invalidStringList', error: `${fieldName} must be an array` };
  }

  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      return { resultType: 'invalidStringList', error: `${fieldName} must contain only strings` };
    }
    const trimmedItem = item.trim();
    if (!trimmedItem) {
      return { resultType: 'invalidStringList', error: `${fieldName} must contain only non-empty strings` };
    }
    if (!values.includes(trimmedItem)) {
      values.push(trimmedItem);
    }
  }

  return { resultType: 'validStringList', values };
}

function isSafeAgentId(agentId: string): boolean {
  return !agentId.includes('/')
    && !agentId.includes(String.fromCharCode(92))
    && !agentId.includes(String.fromCharCode(0))
    && !agentId.includes('..')
    && !/^[A-Za-z]:/.test(agentId);
}

function readRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
