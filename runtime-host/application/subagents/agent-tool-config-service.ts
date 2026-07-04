import { badRequest, ok, type ApplicationResponseOf } from '../common/application-response';
import type {
  AgentToolConfigProjectionPort,
  AgentToolConfigView,
  SetAgentToolConfigCommand,
  SetAgentToolConfigResult,
} from './agent-tool-config-contracts';

type AgentToolConfigFailure = { readonly success: false; readonly error: string };

type ReadAgentToolConfigCommandResult =
  | { readonly resultType: 'validReadAgentToolConfigCommand'; readonly agentId: string }
  | { readonly resultType: 'invalidReadAgentToolConfigCommand'; readonly error: string };

type SetAgentToolConfigCommandResult =
  | { readonly resultType: 'validSetAgentToolConfigCommand'; readonly command: SetAgentToolConfigCommand }
  | { readonly resultType: 'invalidSetAgentToolConfigCommand'; readonly error: string };

type StringListValidationResult =
  | { readonly resultType: 'validStringList'; readonly values: string[] }
  | { readonly resultType: 'invalidStringList'; readonly error: string };

export class AgentToolConfigService {
  constructor(private readonly deps: {
    readonly projection: AgentToolConfigProjectionPort;
  }) {}

  async getConfig(payload: unknown): Promise<ApplicationResponseOf<AgentToolConfigView | AgentToolConfigFailure>> {
    const command = readAgentToolConfigCommand(payload);
    if (command.resultType === 'invalidReadAgentToolConfigCommand') {
      return badRequest(command.error);
    }
    return ok(await this.deps.projection.readAgentToolConfig(command.agentId));
  }

  async setConfig(payload: unknown): Promise<ApplicationResponseOf<SetAgentToolConfigResult | AgentToolConfigFailure>> {
    const command = readSetAgentToolConfigCommand(payload);
    if (command.resultType === 'invalidSetAgentToolConfigCommand') {
      return badRequest(command.error);
    }

    return ok(await this.deps.projection.setAgentToolConfig(command.command));
  }
}

function readAgentToolConfigCommand(payload: unknown): ReadAgentToolConfigCommandResult {
  const record = readRecord(payload);
  const agentId = readTrimmedString(record.agentId) || readTrimmedString(record.subagentId);
  if (!agentId) {
    return { resultType: 'invalidReadAgentToolConfigCommand', error: 'agentId is required' };
  }
  if (!isSafeAgentId(agentId)) {
    return { resultType: 'invalidReadAgentToolConfigCommand', error: 'agentId is invalid' };
  }
  return { resultType: 'validReadAgentToolConfigCommand', agentId };
}

function readSetAgentToolConfigCommand(payload: unknown): SetAgentToolConfigCommandResult {
  const record = readRecord(payload);
  const agentId = readTrimmedString(record.agentId) || readTrimmedString(record.subagentId);
  if (!agentId) {
    return { resultType: 'invalidSetAgentToolConfigCommand', error: 'agentId is required' };
  }
  if (!isSafeAgentId(agentId)) {
    return { resultType: 'invalidSetAgentToolConfigCommand', error: 'agentId is invalid' };
  }

  const revision = readTrimmedString(record.revision);
  if (!revision) {
    return { resultType: 'invalidSetAgentToolConfigCommand', error: 'revision is required' };
  }

  const selection = readRecord(record.selection);
  const selectionType = readTrimmedString(selection.selectionType);
  if (selectionType === 'inheritDefaultTools') {
    return {
      resultType: 'validSetAgentToolConfigCommand',
      command: {
        agentId,
        revision,
        selection: { selectionType: 'inheritDefaultTools' },
      },
    };
  }
  if (selectionType !== 'setAgentToolPolicy') {
    return { resultType: 'invalidSetAgentToolConfigCommand', error: 'selection.selectionType is required' };
  }

  const profile = readTrimmedString(selection.profile);
  if (!profile) {
    return { resultType: 'invalidSetAgentToolConfigCommand', error: 'selection.profile is required' };
  }

  const allow = readRequiredStringList(selection.allow, 'selection.allow');
  if (allow.resultType === 'invalidStringList') {
    return { resultType: 'invalidSetAgentToolConfigCommand', error: allow.error };
  }
  const deny = readRequiredStringList(selection.deny, 'selection.deny');
  if (deny.resultType === 'invalidStringList') {
    return { resultType: 'invalidSetAgentToolConfigCommand', error: deny.error };
  }

  return {
    resultType: 'validSetAgentToolConfigCommand',
    command: {
      agentId,
      revision,
      selection: {
        selectionType: 'setAgentToolPolicy',
        profile,
        allow: allow.values,
        deny: deny.values,
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
