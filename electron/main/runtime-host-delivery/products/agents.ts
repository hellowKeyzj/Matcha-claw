import type { RuntimeHostDeliveryIssuer } from '../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = { success: false, error: 'Subagent management is unavailable' } as const;

type Operation =
  | 'subagents.list'
  | 'subagents.draft.wait'
  | 'subagents.create'
  | 'subagents.update'
  | 'subagents.delete'
  | 'subagents.files.get'
  | 'subagents.files.set'
  | 'subagents.files.list'
  | 'subagents.displayConfig.get'
  | 'subagents.description.set'
  | 'subagents.model.set'
  | 'subagents.skills.set'
  | 'subagentSkills.get'
  | 'subagentSkills.set'
  | 'subagentTools.get'
  | 'subagentTools.set';

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

type AgentTarget = Readonly<{ kind: 'agent'; agentId: string }>;
type SubagentTarget = Readonly<{ kind: 'subagent'; subagentId?: string }>;
type CapabilityId = 'subagent.management' | 'subagent.skills' | 'subagent.tools';
type AgentsRequest = Readonly<{
  id: CapabilityId;
  operationId: Operation;
  scope: Readonly<{ kind: 'agent'; endpoint: Endpoint; agentId: string }>;
  target: AgentTarget | SubagentTarget;
  input: Record<string, unknown>;
}>;

export type AgentsTransportResponse = Readonly<{
  status: 200 | 409 | 422 | 503;
  body: unknown;
}>;

export interface AgentsTransport {
  execute(request: unknown): Promise<AgentsTransportResponse>;
}

export function createAgentsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): AgentsTransport {
  return { execute };

  async function execute(request: unknown): Promise<AgentsTransportResponse> {
    if (!isAgentsRequest(request)) return { status: 503, body: UNAVAILABLE };
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/api/subagents/agents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${issuer.signDecision({
            principal: 'electron-main-local',
            endpoint: '/api/subagents/agents',
            scope: 'subagents:manage',
            capability: request.id,
            subject: 'subagents',
            expiresAt: Date.now() + DECISION_TTL_MS,
            revision: '1',
          })}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      const body: unknown = await response.json();
      if (response.status === 200 && isSuccess(body, request.operationId)) return { status: 200, body };
      if ((response.status === 409 || response.status === 422 || response.status === 503) && isFailure(body)) {
        return { status: response.status, body };
      }
    } catch {
      // Loopback failures intentionally remain public-unavailable.
    }
    return { status: 503, body: UNAVAILABLE };
  }
}

function isAgentsRequest(value: unknown): value is AgentsRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || !isCapabilityId(value.id)
    || !isOperation(value.operationId)
    || !operationMatchesCapability(value.id, value.operationId)
    || !isScope(value.scope)
    || !isTarget(value.target, value.operationId)
    || !isRecord(value.input)) return false;
  return isInput(value.input, value.operationId, value.scope.endpoint, value.target);
}

function isCapabilityId(value: unknown): value is CapabilityId {
  return value === 'subagent.management' || value === 'subagent.skills' || value === 'subagent.tools';
}

function operationMatchesCapability(id: CapabilityId, operation: Operation): boolean {
  if (operation === 'subagentSkills.get' || operation === 'subagentSkills.set') return id === 'subagent.skills';
  if (operation === 'subagentTools.get' || operation === 'subagentTools.set') return id === 'subagent.tools';
  return id === 'subagent.management';
}

function isOperation(value: unknown): value is Operation {
  return value === 'subagents.list'
    || value === 'subagents.draft.wait'
    || value === 'subagents.create'
    || value === 'subagents.update'
    || value === 'subagents.delete'
    || value === 'subagents.files.get'
    || value === 'subagents.files.set'
    || value === 'subagents.files.list'
    || value === 'subagents.displayConfig.get'
    || value === 'subagents.description.set'
    || value === 'subagents.model.set'
    || value === 'subagents.skills.set'
    || value === 'subagentSkills.get'
    || value === 'subagentSkills.set'
    || value === 'subagentTools.get'
    || value === 'subagentTools.set';
}

function isScope(value: unknown): value is Readonly<{ kind: 'agent'; endpoint: Endpoint; agentId: string }> {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'agentId'])
    && value.kind === 'agent'
    && isEndpoint(value.endpoint)
    && isText(value.agentId, 4096);
}

function isTarget(value: unknown, operation: Operation): value is AgentTarget | SubagentTarget {
  if (!isRecord(value)) return false;
  if (operation === 'subagents.list' || operation === 'subagents.displayConfig.get') {
    return hasExactKeys(value, ['kind', 'agentId']) && value.kind === 'agent' && isText(value.agentId, 4096);
  }
  if (value.kind !== 'subagent') return false;
  if (operation === 'subagents.create') return hasExactKeys(value, ['kind']);
  return hasExactKeys(value, ['kind', 'subagentId']) && isText(value.subagentId, 4096);
}

function isInput(
  value: Record<string, unknown>,
  operation: Operation,
  endpoint: Endpoint,
  target: AgentTarget | SubagentTarget,
): boolean {
  const targetMatches = (agentId: unknown) => target.kind === 'subagent' && target.subagentId === agentId;
  if (operation === 'subagentSkills.get' || operation === 'subagentTools.get') {
    return hasExactKeys(value, ['agentId'])
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagentSkills.set') {
    return hasExactKeys(value, ['agentId', 'revision', 'selection'])
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && isText(value.revision, 4096)
      && isSkillSelection(value.selection)
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagentTools.set') {
    return hasExactKeys(value, ['agentId', 'revision', 'selection'])
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && isText(value.revision, 4096)
      && isToolSelection(value.selection)
      && endpoint.runtimeAdapterId === 'openclaw';
  }

  const sameEndpoint = isEndpoint(value.endpoint) && endpointsEqual(value.endpoint, endpoint);
  if (!sameEndpoint) return false;
  if (operation === 'subagents.draft.wait') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'runId', 'waitSliceMs', 'rpcTimeoutBufferMs'])
      && value.kind === 'draftWait'
      && endpoint.runtimeAdapterId === 'openclaw'
      && target.subagentId === value.agentId
      && isText(value.agentId, 4096)
      && isText(value.runId, 4096)
      && isWaitSlice(value.waitSliceMs)
      && isRpcTimeoutBuffer(value.rpcTimeoutBufferMs);
  }
  if (operation === 'subagents.list') return hasExactKeys(value, ['kind', 'endpoint'])
    && value.kind === 'list'
    && target.kind === 'agent';
  if (operation === 'subagents.create') {
    return hasExactKeys(value, ['kind', 'endpoint', 'name', 'workspace', 'model'])
      && value.kind === 'create'
      && isText(value.name, 4096)
      && isText(value.workspace, 4096)
      && (value.model === null || isText(value.model, 4096));
  }
  if (operation === 'subagents.update') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'name', 'workspace', 'model'])
      && value.kind === 'update'
      && target.subagentId === value.agentId
      && isText(value.agentId, 4096)
      && [value.name, value.workspace, value.model].some((field) => field !== null)
      && [value.name, value.workspace, value.model].every((field) => field === null || isText(field, 4096));
  }
  if (operation === 'subagents.delete') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'deleteFiles'])
      && value.kind === 'delete'
      && target.subagentId === value.agentId
      && isText(value.agentId, 4096)
      && typeof value.deleteFiles === 'boolean';
  }
  if (operation === 'subagents.files.list') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId'])
      && value.kind === 'filesList'
      && target.subagentId === value.agentId
      && isText(value.agentId, 4096);
  }
  if (operation === 'subagents.displayConfig.get') {
    return hasExactKeys(value, ['kind', 'endpoint'])
      && value.kind === 'displayConfiguration'
      && target.kind === 'agent'
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.description.set') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'description'])
      && value.kind === 'setDescription'
      && target.subagentId === value.agentId
      && isText(value.agentId, 4096)
      && (value.description === null || isText(value.description, 4096))
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.model.set') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'model'])
      && value.kind === 'setConfigurationModel'
      && target.subagentId === value.agentId
      && isText(value.agentId, 4096)
      && (value.model === null || isModelInput(value.model))
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.skills.set') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'skills'])
      && value.kind === 'setSkills'
      && target.subagentId === value.agentId
      && isText(value.agentId, 4096)
      && Array.isArray(value.skills)
      && value.skills.every((skill) => isText(skill, 4096))
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.files.get') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'name'])
      && value.kind === 'filesGet'
      && target.subagentId === value.agentId
      && isText(value.agentId, 4096)
      && isRootedFileName(value.name);
  }
  return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'name', 'content'])
    && value.kind === 'filesSet'
    && target.subagentId === value.agentId
    && isText(value.agentId, 4096)
    && isRootedFileName(value.name)
    && typeof value.content === 'string'
    && value.content.length <= 1024 * 1024;
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function endpointsEqual(left: Endpoint, right: Endpoint): boolean {
  return left.kind === right.kind
    && left.runtimeAdapterId === right.runtimeAdapterId
    && left.runtimeInstanceId === right.runtimeInstanceId;
}

function isRootedFileName(value: unknown): boolean {
  return value === 'AGENTS.md'
    || value === 'SOUL.md'
    || value === 'TOOLS.md'
    || value === 'IDENTITY.md'
    || value === 'USER.md';
}

function isSuccess(value: unknown, operation: Operation): boolean {
  if (!isRecord(value) || value.success !== true) return false;
  if (operation === 'subagents.draft.wait') {
    return hasExactKeys(value, ['success', 'status', 'startedAt', 'endedAt'])
      && isWaitStatus(value.status)
      && (value.startedAt === null || isTimestamp(value.startedAt))
      && (value.endedAt === null || isTimestamp(value.endedAt))
      && (value.startedAt === null || value.endedAt === null || value.endedAt >= value.startedAt);
  }
  if (operation === 'subagents.list') return hasExactKeys(value, ['success', 'defaultId', 'agents'])
    && isText(value.defaultId, 4096) && Array.isArray(value.agents) && value.agents.every(isAgent);
  if (operation === 'subagents.files.list') return hasExactKeys(value, ['success', 'files'])
    && Array.isArray(value.files) && value.files.every(isFile);
  if (operation === 'subagents.displayConfig.get') return hasExactKeys(value, ['success', 'defaults', 'agents'])
    && isConfigurationDefaults(value.defaults)
    && Array.isArray(value.agents)
    && value.agents.every(isConfigurationAgent);
  if (operation === 'subagents.description.set'
    || operation === 'subagents.model.set'
    || operation === 'subagents.skills.set') return hasExactKeys(value, ['success']);
  if (operation === 'subagentSkills.get' || operation === 'subagentTools.get'
    || operation === 'subagentSkills.set' || operation === 'subagentTools.set') {
    return isConfigurationResult(value, operation);
  }
  if (operation === 'subagents.files.get' || operation === 'subagents.files.set') {
    return hasExactKeys(value, ['success', 'file']) && isFile(value.file);
  }
  return hasExactKeys(value, ['success', 'kind', 'agent'])
    && (value.kind === 'created' || value.kind === 'updated' || value.kind === 'deleted')
    && isMutationAgent(value.agent);
}

function isAgent(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'name', 'workspace', 'model'])
    && isText(value.id, 4096)
    && (value.name === null || isText(value.name, 4096))
    && (value.workspace === null || isText(value.workspace, 4096))
    && (value.model === null || isText(value.model, 4096));
}

function isMutationAgent(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'name', 'model'])
    && isText(value.id, 4096)
    && (value.name === null || isText(value.name, 4096))
    && (value.model === null || isText(value.model, 4096));
}

function isFile(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['name', 'missing', 'size', 'updatedAtMs', 'content'])
    && isRootedFileName(value.name)
    && typeof value.missing === 'boolean'
    && (value.size === null || isTimestamp(value.size))
    && (value.updatedAtMs === null || isTimestamp(value.updatedAtMs))
    && (value.content === null || typeof value.content === 'string');
}

function isSkillSelection(value: unknown): boolean {
  return isRecord(value)
    && ((hasExactKeys(value, ['selectionType']) && value.selectionType === 'inheritDefaultSkills')
      || (hasExactKeys(value, ['selectionType', 'skillKeys'])
        && value.selectionType === 'setExplicitSkillAllowlist'
        && Array.isArray(value.skillKeys)
        && value.skillKeys.every((key) => isText(key, 4096))));
}

function isToolSelection(value: unknown): boolean {
  return isRecord(value)
    && ((hasExactKeys(value, ['selectionType']) && value.selectionType === 'inheritDefaultTools')
      || (hasExactKeys(value, ['selectionType', 'profile', 'allow', 'deny'])
        && value.selectionType === 'setAgentToolPolicy'
        && isText(value.profile, 4096)
        && Array.isArray(value.allow) && value.allow.every((key) => isText(key, 4096))
        && Array.isArray(value.deny) && value.deny.every((key) => isText(key, 4096))));
}

function isConfigurationResult(value: Record<string, unknown>, operation: Operation): boolean {
  const isSkill = operation === 'subagentSkills.get' || operation === 'subagentSkills.set';
  if (hasExactKeys(value, ['success', 'resultType', 'view']) && (value.resultType === 'view' || value.resultType === 'updated')) {
    return isConfigurationView(value.view, isSkill);
  }
  if (hasExactKeys(value, ['success', 'resultType', 'latestView']) && value.resultType === 'staleRevision') {
    return isConfigurationView(value.latestView, isSkill);
  }
  if (hasExactKeys(value, ['success', 'resultType', 'reason']) && value.resultType === 'unsupported') {
    return value.reason === 'agentNotConfigured';
  }
  if (!isSkill) return hasExactKeys(value, ['success', 'resultType', 'unknownToolKeys'])
    && value.resultType === 'invalidToolKeys'
    && Array.isArray(value.unknownToolKeys)
    && value.unknownToolKeys.every((key) => isText(key, 4096));
  return hasExactKeys(value, ['success', 'resultType', 'unknownSkillKeys', 'nonCanonicalSkillKeys'])
    && value.resultType === 'invalidSkillKeys'
    && Array.isArray(value.unknownSkillKeys)
    && value.unknownSkillKeys.every((key) => isText(key, 4096))
    && Array.isArray(value.nonCanonicalSkillKeys)
    && value.nonCanonicalSkillKeys.every((key) => isText(key, 4096));
}

function isConfigurationView(value: unknown, skill: boolean): boolean {
  if (!isRecord(value)) return false;
  const common = isText(value.agentId, 4096)
    && isSupport(value.support)
    && isText(value.revision, 4096)
    && (value.updatedAt === null || isTimestamp(value.updatedAt));
  if (!common) return false;
  return skill ? isSkillConfigurationView(value) : isToolConfigurationView(value);
}

function isSupport(value: unknown): boolean {
  return isRecord(value)
    && ((hasExactKeys(value, ['supportType']) && value.supportType === 'supported')
      || (hasExactKeys(value, ['supportType', 'reason']) && value.supportType === 'unsupported' && value.reason === 'agentNotConfigured'));
}

function isSkillConfigurationView(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['agentId', 'support', 'selectionMode', 'explicitSkillKeys', 'inheritedDefaultSkillKeys', 'effectiveSkillKeys', 'options', 'revision', 'updatedAt'])
    && (value.selectionMode === 'inheritsDefaultSkills' || value.selectionMode === 'usesExplicitSkillAllowlist')
    && [value.explicitSkillKeys, value.inheritedDefaultSkillKeys, value.effectiveSkillKeys].every((items) => Array.isArray(items) && items.every((key) => isText(key, 4096)))
    && Array.isArray(value.options) && value.options.every(isSkillOption);
}

function isSkillOption(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['skillKey', 'displayName', 'description', 'installed', 'selectable', 'unavailableReason', 'missingRequirements'])
    && isText(value.skillKey, 4096) && isText(value.displayName, 4096)
    && typeof value.description === 'string' && typeof value.installed === 'boolean' && typeof value.selectable === 'boolean'
    && (value.unavailableReason === null || value.unavailableReason === 'globalSkillDisabled' || value.unavailableReason === 'blockedByRuntimeAllowlist' || value.unavailableReason === 'missingRequirements')
    && (value.missingRequirements === null || isMissingSkillRequirements(value.missingRequirements));
}

function isMissingSkillRequirements(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['bins', 'anyBins', 'env', 'config', 'os'])
    && [value.bins, value.anyBins, value.env, value.config, value.os].every((items) => Array.isArray(items) && items.every((item) => isText(item, 4096)));
}

function isToolConfigurationView(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['agentId', 'support', 'selectionMode', 'toolPolicy', 'toolProfiles', 'toolGroups', 'toolOptions', 'revision', 'updatedAt'])
    && (value.selectionMode === 'inheritsDefaultTools' || value.selectionMode === 'usesAgentToolPolicy')
    && (value.toolPolicy === null || isToolPolicy(value.toolPolicy))
    && Array.isArray(value.toolProfiles) && value.toolProfiles.every(isToolProfile)
    && Array.isArray(value.toolGroups) && value.toolGroups.every(isToolGroup)
    && Array.isArray(value.toolOptions) && value.toolOptions.every(isToolOption);
}

function isToolPolicy(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ['profile', 'allow', 'deny']) && isText(value.profile, 4096) && Array.isArray(value.allow) && value.allow.every((key) => isText(key, 4096)) && Array.isArray(value.deny) && value.deny.every((key) => isText(key, 4096)); }
function isToolProfile(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ['profileKey', 'displayName']) && isText(value.profileKey, 4096) && isText(value.displayName, 4096); }
function isToolGroup(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ['groupKey', 'displayName', 'source', 'pluginId', 'toolOptions']) && isText(value.groupKey, 4096) && isText(value.displayName, 4096) && (value.source === 'core' || value.source === 'plugin') && (value.pluginId === null || isText(value.pluginId, 4096)) && Array.isArray(value.toolOptions) && value.toolOptions.every(isToolOption); }
function isToolOption(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ['toolKey', 'displayName', 'optionType', 'description', 'source', 'pluginId', 'groupKey', 'groupDisplayName']) && isText(value.toolKey, 4096) && isText(value.displayName, 4096) && (value.optionType === 'tool' || value.optionType === 'group') && (value.description === null || typeof value.description === 'string') && (value.source === 'core' || value.source === 'plugin') && (value.pluginId === null || isText(value.pluginId, 4096)) && (value.groupKey === null || isText(value.groupKey, 4096)) && (value.groupDisplayName === null || isText(value.groupDisplayName, 4096)); }

function isModelInput(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['primary', 'fallbacks'])
    && (value.primary === null || isText(value.primary, 4096))
    && Array.isArray(value.fallbacks)
    && value.fallbacks.every((fallback) => isText(fallback, 4096));
}

function isConfigurationModel(value: unknown): boolean {
  return value === null || isModelInput(value);
}

function isConfigurationDefaults(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['model', 'skills'])
    && isConfigurationModel(value.model)
    && Array.isArray(value.skills)
    && value.skills.every((skill) => isText(skill, 4096));
}

function isConfigurationAgent(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'description', 'model', 'skills'])
    && isText(value.id, 4096)
    && (value.description === null || isText(value.description, 4096))
    && isConfigurationModel(value.model)
    && Array.isArray(value.skills)
    && value.skills.every((skill) => isText(skill, 4096));
}

function isFailure(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['success', 'error']) && value.success === false && typeof value.error === 'string';
}

function isWaitSlice(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1000 && value <= 60000;
}

function isRpcTimeoutBuffer(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10000;
}

function isWaitStatus(value: unknown): boolean {
  return value === 'completed' || value === 'failed' || value === 'timeout' || value === 'pending';
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
