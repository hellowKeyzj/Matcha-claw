import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { logSessionTrace, summarizeIdentifier, traceHeader } from '../transport/sessions/trace';
import { sendLoopbackJson } from '../transport/client';
import { decodeCallReceipt } from '../../../../src/types/call-log/receipt';
import { isCallId } from '../../../../src/types/call-log/decode';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = { success: false, error: 'Subagent management is unavailable' } as const;

type Operation =
  | 'subagents.list'
  | 'subagents.create'
  | 'subagents.update'
  | 'subagents.delete'
  | 'subagents.files.get'
  | 'subagents.files.set'
  | 'subagents.files.list'
  | 'subagents.displayConfig.get'
  | 'subagents.package.export'
  | 'subagents.package.exportCloud'
  | 'subagents.package.install'
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
  status: 200 | 202 | 404 | 409 | 422 | 503;
  body: unknown;
}>;

export type SubagentCloudArtifactRequest = Readonly<{
  callId: string;
  operationId: 'subagents.package.exportCloud';
  endpoint: Endpoint;
  agentId: string;
}>;

export interface AgentsTransport {
  execute(request: unknown, traceId?: string | null): Promise<AgentsTransportResponse>;
  result(request: unknown): Promise<AgentsTransportResponse>;
  exportCloudArtifact(request: SubagentCloudArtifactRequest): Promise<AgentsTransportResponse>;
}

export function createAgentsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): AgentsTransport {
  return { execute, result, exportCloudArtifact };

  async function exportCloudArtifact(request: SubagentCloudArtifactRequest): Promise<AgentsTransportResponse> {
    if (!isResultRequest(request) || request.operationId !== 'subagents.package.exportCloud'
      || request.endpoint.runtimeAdapterId !== 'openclaw') return { status: 503, body: UNAVAILABLE };
    const response = await sendLoopbackJson({
      port, path: '/api/subagents/package-artifacts', issuer,
      decision: {
        endpoint: '/api/subagents/package-artifacts', scope: 'subagents:manage',
        capability: 'subagent.management', subject: 'subagents',
      },
      method: 'POST', fetcher, body: request, timeoutMs: 30_000,
    });
    if (response?.status === 200 && isPackageArtifact(response.body, request)) return { status: 200, body: response.body };
    if (response && (response.status === 404 || response.status === 409 || response.status === 503)
      && isFailure(response.body)) return { status: response.status, body: response.body };
    return { status: 503, body: UNAVAILABLE };
  }

  async function result(request: unknown): Promise<AgentsTransportResponse> {
    if (!isResultRequest(request)) return { status: 503, body: UNAVAILABLE };
    const response = await sendLoopbackJson({
      port,
      path: '/api/subagents/results',
      issuer,
      decision: {
        endpoint: '/api/subagents/results', scope: 'subagents:manage',
        capability: capabilityForOperation(request.operationId), subject: 'subagents',
      },
      method: 'POST', fetcher, body: request, timeoutMs: 30_000,
    });
    if (response?.status === 200 && isResultResponse(response.body, request)) {
      return { status: 200, body: response.body };
    }
    if (response && (response.status === 404 || response.status === 409 || response.status === 422 || response.status === 503)
      && isFailure(response.body)) return { status: response.status, body: response.body };
    return { status: 503, body: UNAVAILABLE };
  }

  async function execute(request: unknown, traceId?: string | null): Promise<AgentsTransportResponse> {
    if (!isAgentsRequest(request)) {
      logSessionTrace('electron.agents.rejected', traceId, summarizeUnknownAgentsRequest(request));
      return { status: 503, body: UNAVAILABLE };
    }
    const startedAt = Date.now();
    logSessionTrace('electron.agents.request', traceId, summarizeAgentsRequest(request));
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
          ...traceHeader(traceId),
        },
        body: JSON.stringify(request),
        ...(isBackgroundOperation(request.operationId) ? { signal: AbortSignal.timeout(30_000) } : {}),
      });
      const body: unknown = await response.json();
      if (isBackgroundOperation(request.operationId) && response.status === 202) {
        return { status: 202, body: decodeCallReceipt(body) };
      }
      const validSuccess = !isBackgroundOperation(request.operationId)
        && response.status === 200 && isSuccess(body, request.operationId);
      const validFailure = (response.status === 409 || response.status === 422 || response.status === 503) && isFailure(body);
      logSessionTrace('electron.agents.response', traceId, {
        operationId: request.operationId,
        status: response.status,
        contract: validSuccess ? summarizeSuccessfulAgentsBody(body, request.operationId) : validFailure ? 'failure' : 'invalid',
        elapsedMs: Date.now() - startedAt,
      });
      if (validSuccess) return { status: 200, body };
      if (validFailure) {
        return { status: response.status, body };
      }
    } catch {
      logSessionTrace('electron.agents.failure', traceId, {
        operationId: request.operationId,
        elapsedMs: Date.now() - startedAt,
      });
      // Loopback failures intentionally remain public-unavailable.
    }
    return { status: 503, body: UNAVAILABLE };
  }
}

function summarizeUnknownAgentsRequest(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { contract: 'non-record' };
  return {
    contract: 'invalid',
    id: typeof value.id === 'string' ? value.id : null,
    operationId: typeof value.operationId === 'string' ? value.operationId : null,
    keys: Object.keys(value).sort(),
  };
}

function summarizeAgentsRequest(request: AgentsRequest): Record<string, unknown> {
  const inputAgentId = typeof request.input.agentId === 'string' ? request.input.agentId : null;
  return {
    id: request.id,
    operationId: request.operationId,
    adapter: request.scope.endpoint.runtimeAdapterId,
    instance: request.scope.endpoint.runtimeInstanceId,
    scopeAgentId: summarizeIdentifier(request.scope.agentId),
    targetKind: request.target.kind,
    targetAgentId: summarizeIdentifier(request.target.kind === 'agent' ? request.target.agentId : null),
    targetSubagentId: summarizeIdentifier(request.target.kind === 'subagent' ? request.target.subagentId ?? null : null),
    inputAgentId: summarizeIdentifier(inputAgentId),
  };
}

function summarizeSuccessfulAgentsBody(body: unknown, operation: Operation): string {
  if (operation === 'subagentSkills.get') return 'skill-view';
  if (operation === 'subagentTools.get') return 'tool-view';
  if (operation === 'subagentSkills.set' || operation === 'subagentTools.set') {
    return isRecord(body) && typeof body.resultType === 'string' ? `mutation:${body.resultType}` : 'mutation';
  }
  if (isRecord(body) && typeof body.kind === 'string') return `mutation:${body.kind}`;
  return 'success';
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
    || value === 'subagents.create'
    || value === 'subagents.update'
    || value === 'subagents.delete'
    || value === 'subagents.files.get'
    || value === 'subagents.files.set'
    || value === 'subagents.files.list'
    || value === 'subagents.displayConfig.get'
    || value === 'subagents.package.export'
    || value === 'subagents.package.exportCloud'
    || value === 'subagents.package.install'
    || value === 'subagents.description.set'
    || value === 'subagents.model.set'
    || value === 'subagents.skills.set'
    || value === 'subagentSkills.get'
    || value === 'subagentSkills.set'
    || value === 'subagentTools.get'
    || value === 'subagentTools.set';
}

function isBackgroundOperation(operation: Operation): boolean {
  return operation === 'subagents.create' || operation === 'subagents.update' || operation === 'subagents.delete'
    || operation === 'subagents.description.set' || operation === 'subagents.model.set'
    || operation === 'subagents.skills.set' || operation === 'subagentSkills.set'
    || operation === 'subagentTools.set' || operation === 'subagents.package.install'
    || operation === 'subagents.package.export' || operation === 'subagents.package.exportCloud';
}

function capabilityForOperation(operation: Operation): CapabilityId {
  return operation === 'subagentSkills.set' ? 'subagent.skills'
    : operation === 'subagentTools.set' ? 'subagent.tools' : 'subagent.management';
}

type ResultRequest = { callId: string; operationId: Operation; endpoint: Endpoint; agentId?: string };

function isResultRequest(value: unknown): value is ResultRequest {
  if (!isRecord(value) || !isCallId(value.callId) || !isOperation(value.operationId)
    || !isBackgroundOperation(value.operationId) || !isEndpoint(value.endpoint)) return false;
  if ((value.operationId === 'subagents.package.export' || value.operationId === 'subagents.package.exportCloud')
    && value.endpoint.runtimeAdapterId !== 'openclaw') return false;
  const root = value.operationId === 'subagents.create' || value.operationId === 'subagents.package.install';
  return hasExactKeys(value, root ? ['callId', 'operationId', 'endpoint'] : ['callId', 'operationId', 'endpoint', 'agentId'])
    && (root || isText(value.agentId, 4096));
}

function isResultResponse(value: unknown, request: ResultRequest): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['callId', 'operationId', 'status', 'body'])
    || value.callId !== request.callId || value.operationId !== request.operationId
    || !isRecord(value.body)) return false;
  const body = value.body;
  if (request.operationId === 'subagents.delete' && isDeleteResult(body)) {
    return body.agent.id === request.agentId && (value.status === 200 ? body.success === true : value.status === 503 && body.success === false);
  }
  if (value.status === 200) {
    if (!isMutationResult(body, request.operationId)) return false;
    if (request.agentId !== undefined) {
      if (isRecord(body.agent) && body.agent.id !== request.agentId) return false;
      if (isRecord(body.package) && body.package.agentId !== request.agentId) return false;
      for (const key of ['view', 'latestView']) {
        if (isRecord(body[key]) && body[key].agentId !== request.agentId) return false;
      }
    }
    return true;
  }
  if (value.status !== 409 && value.status !== 422 && value.status !== 503) return false;
  if (request.operationId === 'subagents.create' && value.status === 503
    && hasExactKeys(body, ['success', 'error', 'agent']) && body.success === false
    && body.error === 'Subagent workspace initialization failed' && isMutationAgent(body.agent)) return true;
  if (request.operationId === 'subagents.package.install' && hasExactKeys(body, ['success', 'error', 'agentId', 'compensation'])) {
    return body.success === false && body.error === 'Subagent package installation failed'
      && isText(body.agentId, 4096) && isCompensation(body.compensation);
  }
  return isFailure(body) && (body.error === 'Subagent request was rejected'
    || body.error === 'Subagent mutation outcome is unknown'
    || body.error === 'Subagent management is unsupported for this runtime'
    || body.error === 'Subagent management is unavailable');
}

function isMutationResult(value: Record<string, unknown>, operation: Operation): boolean {
  if (value.success !== true) return false;
  if (operation === 'subagents.create' || operation === 'subagents.update') {
    return hasExactKeys(value, ['success', 'kind', 'agent'])
      && value.kind === (operation === 'subagents.create' ? 'created' : 'updated') && isMutationAgent(value.agent);
  }
  if (operation === 'subagents.package.install') return hasExactKeys(value, ['success', 'package']) && isPackageInstall(value.package);
  if (operation === 'subagents.package.export' || operation === 'subagents.package.exportCloud') {
    return hasExactKeys(value, ['success', 'package']) && isPackageExport(value.package);
  }
  if (operation === 'subagentSkills.set' || operation === 'subagents.skills.set') {
    return (operation === 'subagents.skills.set' && hasExactKeys(value, ['success'])) || isConfigurationMutationResult(value, true);
  }
  if (operation === 'subagentTools.set') return isConfigurationMutationResult(value, false);
  return (operation === 'subagents.description.set' || operation === 'subagents.model.set') && hasExactKeys(value, ['success']);
}

function isDeleteResult(value: Record<string, unknown>): value is Record<string, unknown> & { agent: { id: string }; success: boolean } {
  if (!hasExactKeys(value, ['success', 'kind', 'agent', 'nativeOk', 'removedBindings', 'failedCount', 'purgeFailedCount', 'sealedPurge'])
    || typeof value.success !== 'boolean' || value.kind !== 'deleted' || !isMutationAgent(value.agent)
    || !isRecord(value.agent) || value.agent.name !== null || value.agent.model !== null
    || typeof value.nativeOk !== 'boolean' || !isTimestamp(value.removedBindings)
    || !isTimestamp(value.failedCount) || !isTimestamp(value.purgeFailedCount)
    || (value.sealedPurge !== 'completed' && value.sealedPurge !== 'failed' && value.sealedPurge !== 'notAttempted')) return false;
  return value.success === (value.nativeOk && value.failedCount === 0 && value.purgeFailedCount === 0 && value.sealedPurge === 'completed');
}

function isCompensation(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['outcome', 'failedCount', 'purgeFailedCount'])
    && typeof value.outcome === 'string' && ['deleted', 'rejected', 'outcomeUnknown', 'unsupported', 'unavailable'].includes(value.outcome)
    && isTimestamp(value.failedCount) && isTimestamp(value.purgeFailedCount)
    && (value.outcome !== 'deleted' || (value.failedCount === 0 && value.purgeFailedCount === 0));
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
  if (operation === 'subagents.create' || operation === 'subagents.package.install') return hasExactKeys(value, ['kind']);
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
  if (operation === 'subagents.list') return hasExactKeys(value, ['kind', 'endpoint'])
    && value.kind === 'list'
    && target.kind === 'agent';
  if (operation === 'subagents.create') {
    return hasAllowedKeys(value, ['kind', 'endpoint', 'name', 'workspace', 'model', 'workspaceInitialization'], ['kind', 'endpoint', 'name', 'workspace', 'model'])
      && value.kind === 'create'
      && isText(value.name, 4096)
      && isText(value.workspace, 4096)
      && (value.model === null || isText(value.model, 4096))
      && (!Object.hasOwn(value, 'workspaceInitialization') || isWorkspaceInitialization(value.workspaceInitialization));
  }
  if (operation === 'subagents.update') {
    return hasAllowedKeys(value, ['kind', 'endpoint', 'agentId', 'name', 'workspace', 'model'], ['kind', 'endpoint', 'agentId'])
      && value.kind === 'update'
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && (Object.hasOwn(value, 'name') || Object.hasOwn(value, 'workspace') || Object.hasOwn(value, 'model'))
      && (!Object.hasOwn(value, 'name') || isText(value.name, 4096))
      && (!Object.hasOwn(value, 'workspace') || isText(value.workspace, 4096))
      && (!Object.hasOwn(value, 'model') || value.model === null || isText(value.model, 4096));
  }
  if (operation === 'subagents.delete') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'deleteFiles'])
      && value.kind === 'delete'
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && typeof value.deleteFiles === 'boolean';
  }
  if (operation === 'subagents.files.list') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId'])
      && value.kind === 'filesList'
      && targetMatches(value.agentId)
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
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && (value.description === null || isText(value.description, 4096))
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.model.set') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'model'])
      && value.kind === 'setConfigurationModel'
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && (value.model === null || isModelInput(value.model))
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.skills.set') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'skills'])
      && value.kind === 'setSkills'
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && Array.isArray(value.skills)
      && value.skills.every((skill) => isText(skill, 4096))
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.package.export') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId'])
      && value.kind === 'packageExport'
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.package.exportCloud') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'cloudPublicKey', 'cloudKeyId'])
      && value.kind === 'packageExportCloud'
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && isText(value.cloudPublicKey, 8192)
      && isText(value.cloudKeyId, 512)
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.package.install') {
    return hasAllowedKeys(value, ['kind', 'endpoint', 'packagePath', 'cloudMetadata'], ['kind', 'endpoint', 'packagePath'])
      && value.kind === 'packageInstall'
      && target.kind === 'subagent' && target.subagentId === undefined
      && isText(value.packagePath, 4096)
      && (value.cloudMetadata === undefined || isCloudPackageInstallMetadata(value.cloudMetadata))
      && endpoint.runtimeAdapterId === 'openclaw';
  }
  if (operation === 'subagents.files.get') {
    return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'name'])
      && value.kind === 'filesGet'
      && targetMatches(value.agentId)
      && isText(value.agentId, 4096)
      && isRootedFileName(value.name);
  }
  return hasExactKeys(value, ['kind', 'endpoint', 'agentId', 'name', 'content'])
    && value.kind === 'filesSet'
    && targetMatches(value.agentId)
    && isText(value.agentId, 4096)
    && isRootedFileName(value.name)
    && typeof value.content === 'string'
    && Buffer.byteLength(value.content, 'utf8') <= 1024 * 1024;
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
    || value === 'USER.md'
    || value === 'MEMORY.md';
}

function isWorkspaceInitialization(value: unknown): boolean {
  return value === 'mainAgentTemplate' || value === 'emptyWorkspace';
}

function isSuccess(value: unknown, operation: Operation): boolean {
  if (operation === 'subagentSkills.get') return isConfigurationView(value, true);
  if (operation === 'subagentTools.get') return isConfigurationView(value, false);
  if (!isRecord(value) || value.success !== true) return false;
  if (operation === 'subagents.list') return hasExactKeys(value, ['success', 'defaultId', 'selectionRequired', 'agents'])
    && isText(value.defaultId, 4096)
    && typeof value.selectionRequired === 'boolean'
    && Array.isArray(value.agents)
    && value.agents.every(isAgent);
  if (operation === 'subagents.files.list') return hasExactKeys(value, ['success', 'files'])
    && Array.isArray(value.files) && value.files.every(isFile);
  if (operation === 'subagents.displayConfig.get') return hasExactKeys(value, ['success', 'defaults', 'agents'])
    && isConfigurationDefaults(value.defaults)
    && Array.isArray(value.agents)
    && value.agents.every(isConfigurationAgent);
  if (operation === 'subagents.files.get' || operation === 'subagents.files.set') {
    return hasExactKeys(value, ['success', 'file']) && isFile(value.file);
  }
  return false;
}

function isAgent(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'name', 'workspace', 'model', 'kind', 'sealed'])
    && isText(value.id, 4096)
    && (value.name === null || isText(value.name, 4096))
    && (value.workspace === null || isText(value.workspace, 4096))
    && (value.model === null || isText(value.model, 4096))
    && (value.kind === 'agent' || value.kind === 'system')
    && typeof value.sealed === 'boolean';
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

function isPackageExport(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['agentId', 'fileName', 'size', 'exportedAtMs'])
    && isText(value.agentId, 4096)
    && isText(value.fileName, 4096)
    && isTimestamp(value.size)
    && isTimestamp(value.exportedAtMs);
}

function isPackageArtifact(value: unknown, request: SubagentCloudArtifactRequest): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['callId', 'operationId', 'package'])
    || value.callId !== request.callId || value.operationId !== request.operationId || !isRecord(value.package)) return false;
  const { packageSha256, packageBase64, ...metadata } = value.package;
  return isPackageExport(metadata) && metadata.agentId === request.agentId
    && typeof metadata.size === 'number' && metadata.size > 0 && metadata.size <= 256 * 1024
    && isPackageSha256(packageSha256) && typeof packageBase64 === 'string'
    && packageBase64.length === Math.ceil(metadata.size / 3) * 4
    && /^[A-Za-z0-9+/]+={0,2}$/.test(packageBase64)
    && Buffer.from(packageBase64, 'base64').length === metadata.size;
}

function isPackageInstall(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['agentId'])
    && isText(value.agentId, 4096);
}

function isCloudPackageInstallMetadata(value: unknown): boolean {
  return isRecord(value)
    && hasAllowedKeys(value, ['packageVersionId', 'packageType', 'packageSha256', 'fileName'], ['packageVersionId', 'packageType', 'packageSha256', 'fileName'])
    && isText(value.packageVersionId, 512)
    && isText(value.packageType, 128)
    && isPackageSha256(value.packageSha256)
    && isText(value.fileName, 512);
}

function isPackageSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
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

function isConfigurationMutationResult(value: Record<string, unknown>, skill: boolean): boolean {
  if (hasExactKeys(value, ['success', 'resultType', 'view']) && value.resultType === 'updated') {
    return isConfigurationView(value.view, skill);
  }
  if (hasExactKeys(value, ['success', 'resultType', 'latestView']) && value.resultType === 'staleRevision') {
    return isConfigurationView(value.latestView, skill);
  }
  if (hasExactKeys(value, ['success', 'resultType', 'reason']) && value.resultType === 'unsupported') {
    return value.reason === 'agentNotConfigured';
  }
  if (!skill) return hasExactKeys(value, ['success', 'resultType', 'unknownToolKeys'])
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
      || (hasExactKeys(value, ['supportType', 'reason']) && value.supportType === 'unsupported' && isUnsupportedReason(value.reason)));
}

function isUnsupportedReason(value: unknown): boolean {
  return value === 'agentNotConfigured'
    || value === 'runtimeDoesNotExposeAgentSkillConfig'
    || value === 'runtimeDoesNotExposeAgentToolConfig';
}

function isSkillConfigurationView(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['agentId', 'support', 'selectionMode', 'explicitSkillKeys', 'inheritedDefaultSkillKeys', 'effectiveSkillKeys', 'options', 'revision', 'updatedAt'])
    && (value.selectionMode === 'inheritsDefaultSkills' || value.selectionMode === 'usesExplicitSkillAllowlist')
    && [value.explicitSkillKeys, value.inheritedDefaultSkillKeys, value.effectiveSkillKeys].every((items) => Array.isArray(items) && items.every((key) => isText(key, 4096)))
    && Array.isArray(value.options) && value.options.every(isSkillOption);
}

function isSkillOption(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['skillKey', 'displayName', 'description', 'selectable', 'unavailableReason', 'missingRequirements'])
    && isText(value.skillKey, 4096) && isText(value.displayName, 4096)
    && typeof value.description === 'string' && typeof value.selectable === 'boolean'
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
function isToolOption(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['toolKey', 'displayName', 'optionType', 'description', 'source', 'pluginId', 'optional', 'risk', 'tags', 'defaultProfiles', 'deniedByGlobalPolicy', 'groupKey', 'groupDisplayName'])
    && isText(value.toolKey, 4096)
    && isText(value.displayName, 4096)
    && (value.optionType === 'tool' || value.optionType === 'group')
    && (value.description === null || typeof value.description === 'string')
    && (value.source === 'core' || value.source === 'plugin')
    && (value.pluginId === null || isText(value.pluginId, 4096))
    && (value.optional === null || typeof value.optional === 'boolean')
    && (value.risk === null || value.risk === 'low' || value.risk === 'medium' || value.risk === 'high')
    && Array.isArray(value.tags)
    && value.tags.every((tag) => isText(tag, 4096))
    && Array.isArray(value.defaultProfiles)
    && value.defaultProfiles.every((profile) => isText(profile, 4096))
    && typeof value.deniedByGlobalPolicy === 'boolean'
    && (value.groupKey === null || isText(value.groupKey, 4096))
    && (value.groupDisplayName === null || isText(value.groupDisplayName, 4096));
}

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

function isTimestamp(value: unknown): value is number {
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

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key))
    && required.every((key) => Object.hasOwn(value, key));
}
