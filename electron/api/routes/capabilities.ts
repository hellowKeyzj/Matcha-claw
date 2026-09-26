import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  validateRuntimeScope,
  type RuntimeScope,
} from '../../../src/types/desktop/runtime-address';
import type { RuntimeHostJsonValue } from '../../main/runtime-host-delivery/control';
import type { RuntimeHostTransportContext } from '../context';
import { dispatchSessionCapability, type SessionCapabilityRouteDeps } from './sessions';
import {
  logSessionTrace,
  readTraceHeader,
  summarizeIdentifier,
} from '../../main/runtime-host-delivery/transport/sessions/trace';
import { isTeamRuntimeCapabilityRequest } from './team-runtime-capability';
import { parseJsonBody, sendJson } from '../route-utils';
import type { TaskManagerTransport } from '../../main/runtime-host-delivery/transport/task-manager';

const CAPABILITY_NOT_AVAILABLE = {
  success: false,
  error: 'Capability is not available',
} as const;
const CAPABILITY_DIRECTORY_UNAVAILABLE = {
  success: false,
  error: 'Capability directory is unavailable',
} as const;
const CAPABILITY_REQUEST_FAILED = {
  success: false,
  error: 'Capability request failed',
} as const;
const CRON_TRIGGER_INVALID = {
  success: false,
  error: 'Cron trigger request is invalid',
} as const;
const CRON_SERVICE_UNAVAILABLE = {
  success: false,
  error: 'Cron service is unavailable',
} as const;
const PROVIDER_ROUTING_INVALID = {
  success: false,
  error: 'Provider routing request is invalid',
} as const;
const PROVIDER_ROUTING_UNAVAILABLE = {
  success: false,
  error: 'Provider routing is unavailable',
} as const;
const SUBAGENT_CONFIGURATION_UNAVAILABLE = {
  success: false,
  error: 'Subagent configuration is unavailable',
} as const;
const TASK_MANAGER_INVALID = {
  success: false,
  error: 'Task manager request is invalid',
} as const;
const TASK_MANAGER_UNAVAILABLE = {
  success: false,
  error: 'Task manager is unavailable',
} as const;
const TEAM_RUNTIME_REQUEST_INVALID = {
  success: false,
  error: 'Team runtime request is invalid',
} as const;
const TEAM_RUNTIME_UNAVAILABLE = {
  success: false,
  error: 'Team runtime operation is unavailable',
} as const;
const OPENCLAW_BROWSER_REQUEST_INVALID = {
  success: false,
  error: 'OpenClaw browser request is invalid',
} as const;
const OPENCLAW_BROWSER_UNAVAILABLE = {
  success: false,
  error: 'OpenClaw browser request is unavailable',
} as const;
const OPENCLAW_MCP_APP_REQUEST_INVALID = {
  success: false,
  error: 'OpenClaw MCP app request is invalid',
} as const;
const OPENCLAW_MCP_APP_UNAVAILABLE = {
  success: false,
  error: 'OpenClaw MCP app request is unavailable',
} as const;
type CapabilityRouteContext = SessionCapabilityRouteDeps
  & RuntimeHostTransportContext<
    | 'capabilityDirectoryTransport'
    | 'providerRoutingTransport'
    | 'taskManagerTransport'
    | 'workspaceMediaTransport'
    | 'agentsTransport'
    | 'cronTransport'
    | 'pluginsTransport'
    | 'skillsManagementTransport'
    | 'teamRuntimeTransport'
    | 'openClawGatewayTransport'
  >;

type TaskOperation =
  | 'tasks.list'
  | 'tasks.get'
  | 'tasks.create'
  | 'tasks.update'
  | 'todos.get'
  | 'todos.write';

const taskDispatch: Readonly<Record<TaskOperation, keyof TaskManagerTransport>> = {
  'tasks.list': 'list',
  'tasks.get': 'get',
  'tasks.create': 'create',
  'tasks.update': 'update',
  'todos.get': 'getTodos',
  'todos.write': 'writeTodos',
};

export async function handleCapabilityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CapabilityRouteContext,
): Promise<boolean> {
  if (url.pathname === '/api/capabilities/list' && req.method === 'GET') {
    try {
      const response = await deps.runtimeHostTransports.capabilityDirectoryTransport.list();
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, CAPABILITY_DIRECTORY_UNAVAILABLE);
    }
    return true;
  }

  if (url.pathname === '/api/capabilities/describe' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      sendJson(res, 500, CAPABILITY_REQUEST_FAILED);
      return true;
    }
    if (!isCapabilityDescribeRequest(body)) {
      sendJson(res, 404, CAPABILITY_NOT_AVAILABLE);
      return true;
    }
    try {
      const response = await deps.runtimeHostTransports.capabilityDirectoryTransport.describe(body);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, CAPABILITY_DIRECTORY_UNAVAILABLE);
    }
    return true;
  }

  if (url.pathname !== '/api/capabilities/execute' || req.method !== 'POST') {
    return false;
  }

  let body: unknown;
  try {
    body = await parseJsonBody<unknown>(req);
  } catch {
    sendJson(res, 500, CAPABILITY_REQUEST_FAILED);
    return true;
  }

  if (isRecord(body) && body.id === 'workspace.media') {
    try {
      const response = await deps.runtimeHostTransports.workspaceMediaTransport.execute(body);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, { success: false, error: 'Workspace media is unavailable' });
    }
    return true;
  }

  if (isRecord(body) && isSubagentConfigurationCapabilityId(body.id)) {
    const traceId = readTraceHeader(req.headers);
    logSessionTrace('capability.subagent.configuration.dispatch', traceId, summarizeSubagentConfigurationRequest(body));
    try {
      const response = await deps.runtimeHostTransports.agentsTransport.execute(body, traceId);
      logSessionTrace('capability.subagent.configuration.response', traceId, {
        status: response.status,
        contract: summarizeSubagentConfigurationResponse(response.body),
      });
      sendJson(res, response.status, response.body);
    } catch {
      logSessionTrace('capability.subagent.configuration.failure', traceId, {});
      sendJson(res, 503, SUBAGENT_CONFIGURATION_UNAVAILABLE);
    }
    return true;
  }

  try {
    const sessionResponse = await dispatchSessionCapability(body, deps, readTraceHeader(req.headers));
    if (sessionResponse) {
      sendJson(res, sessionResponse.status, sessionResponse.body);
      return true;
    }
  } catch {
    sendJson(res, 500, CAPABILITY_REQUEST_FAILED);
    return true;
  }

  if (isRecord(body) && body.id === 'scheduler.cron') {
    const jobId = decodeCronTriggerJobId(body);
    if (!jobId) {
      sendJson(res, 400, CRON_TRIGGER_INVALID);
      return true;
    }

    try {
      const response = await deps.runtimeHostTransports.cronTransport.trigger(body);
      const result = decodeCronTriggerResult(response.body);
      if (result) {
        sendJson(res, 200, result);
      } else if (response.status === 409) {
        sendJson(res, 200, { success: true, result: { outcome: 'outcome-unknown' } });
      } else {
        sendJson(res, 503, CRON_SERVICE_UNAVAILABLE);
      }
    } catch {
      sendJson(res, 503, CRON_SERVICE_UNAVAILABLE);
    }
    return true;
  }

  if (!isRecord(body)) {
    sendJson(res, 404, CAPABILITY_NOT_AVAILABLE);
    return true;
  }

  if (body.id === 'openclaw.browser') {
    const response = await executeOpenClawBrowserCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'openclaw.mcpApp') {
    const response = await executeOpenClawMcpAppCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'team.runtime') {
    const traceId = readTraceHeader(req.headers);
    logSessionTrace('electron.team.runtime.request', traceId, summarizeTeamRuntimeRequest(body));
    if (!isTeamRuntimeCapabilityRequest(body)) {
      logSessionTrace('electron.team.runtime.request-invalid', traceId, summarizeTeamRuntimeRequest(body));
      sendJson(res, 400, TEAM_RUNTIME_REQUEST_INVALID);
      return true;
    }
    try {
      logSessionTrace('electron.team.runtime.transport.request', traceId, summarizeTeamRuntimeRequest(body));
      const response = await deps.runtimeHostTransports.teamRuntimeTransport.execute(body, traceId ?? undefined);
      logSessionTrace('electron.team.runtime.transport.response', traceId, {
        status: response.status,
        contract: summarizeTeamRuntimeResult(response.body),
      });
      logSessionTrace('electron.team.runtime.response', traceId, {
        status: response.status,
        contract: response.status === 200 ? 'operation-result' : 'unavailable',
      });
      sendJson(res, response.status, response.body);
    } catch {
      logSessionTrace('electron.team.runtime.failure', traceId, {});
      sendJson(res, 503, TEAM_RUNTIME_UNAVAILABLE);
    }
    return true;
  }

  if (body.id === 'skill.management') {
    try {
      const response = await deps.runtimeHostTransports.skillsManagementTransport.execute(body);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, { outcome: 'unknown' });
    }
    return true;
  }

  if (body.id === 'plugin.runtime') {
    const response = await executePluginRuntimeCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'provider.routing') {
    if (!isProviderRoutingRequest(body)) {
      sendJson(res, 400, PROVIDER_ROUTING_INVALID);
      return true;
    }
    if (!deps.runtimeHostTransports.providerRoutingTransport) {
      sendJson(res, 503, PROVIDER_ROUTING_UNAVAILABLE);
      return true;
    }
    try {
      const response = await deps.runtimeHostTransports.providerRoutingTransport.execute(body);
      if (!isProviderRoutingResponse(response.body)) {
        sendJson(res, 503, PROVIDER_ROUTING_UNAVAILABLE);
      } else {
        sendJson(res, response.status, response.body);
      }
    } catch {
      sendJson(res, 503, PROVIDER_ROUTING_UNAVAILABLE);
    }
    return true;
  }


  if (body.id === 'task.management') {
    const operation = isTaskOperation(body.operationId) ? body.operationId : undefined;
    if (!operation || !isTaskCapabilityRequest(body, operation)) {
      sendJson(res, 400, TASK_MANAGER_INVALID);
      return true;
    }
    try {
      const response = await deps.runtimeHostTransports.taskManagerTransport[taskDispatch[operation]](body);
      if (!isTaskManagerResponse(response.body, operation)) {
        sendJson(res, 503, TASK_MANAGER_UNAVAILABLE);
      } else {
        sendJson(res, response.status, response.body);
      }
    } catch {
      sendJson(res, 503, TASK_MANAGER_UNAVAILABLE);
    }
    return true;
  }

  sendJson(res, 404, CAPABILITY_NOT_AVAILABLE);
  return true;
}

const CAPABILITY_REJECTED = { outcome: 'rejected' } as const;
const PLUGIN_RUNTIME_UNAVAILABLE = { outcome: 'unknown' } as const;

type PluginRuntimeCapabilityRequest = Readonly<{
  id: 'plugin.runtime';
  operationId: 'plugins.setEnabled';
  scope: unknown;
  target: Readonly<{ kind: 'plugin'; pluginId: string }>;
  input: Readonly<{ enabled: boolean; pluginIds: [string] }>;
}>;

type SubagentConfigurationCapabilityId = 'subagent.skills' | 'subagent.tools';

function isSubagentConfigurationCapabilityId(value: unknown): value is SubagentConfigurationCapabilityId {
  return value === 'subagent.skills' || value === 'subagent.tools';
}

function summarizeSubagentConfigurationRequest(body: Record<string, unknown>): Record<string, unknown> {
  const scope = isRecord(body.scope) ? body.scope : null;
  const endpoint = scope && isRecord(scope.endpoint) ? scope.endpoint : null;
  const target = isRecord(body.target) ? body.target : null;
  const input = isRecord(body.input) ? body.input : null;
  return {
    id: body.id,
    operationId: typeof body.operationId === 'string' ? body.operationId : null,
    adapter: endpoint && typeof endpoint.runtimeAdapterId === 'string' ? endpoint.runtimeAdapterId : null,
    instance: endpoint && typeof endpoint.runtimeInstanceId === 'string' ? endpoint.runtimeInstanceId : null,
    scopeAgentId: summarizeIdentifier(scope && typeof scope.agentId === 'string' ? scope.agentId : null),
    targetKind: target && typeof target.kind === 'string' ? target.kind : null,
    targetSubagentId: summarizeIdentifier(target && typeof target.subagentId === 'string' ? target.subagentId : null),
    inputAgentId: summarizeIdentifier(input && typeof input.agentId === 'string' ? input.agentId : null),
  };
}

function summarizeSubagentConfigurationResponse(body: unknown): string {
  if (!isRecord(body)) return 'invalid';
  if (body.success === false && typeof body.error === 'string') return 'failure';
  if (typeof body.resultType === 'string') return `mutation:${body.resultType}`;
  if (typeof body.agentId === 'string' && isRecord(body.support)) return 'view';
  return 'invalid';
}

function summarizeTeamRuntimeRequest(body: Record<string, unknown>): Record<string, unknown> {
  const target = isRecord(body.target) ? body.target : null;
  const input = isRecord(body.input) ? body.input : null;
  return {
    operationId: typeof body.operationId === 'string' ? body.operationId : null,
    targetKind: target && typeof target.kind === 'string' ? target.kind : null,
    teamId: summarizeIdentifier(readString(input, 'teamId') ?? readString(target, 'teamId')),
    runId: summarizeIdentifier(readString(input, 'runId') ?? readString(target, 'runId')),
    approvalId: summarizeIdentifier(readString(input, 'approvalId') ?? readString(target, 'approvalId')),
    packagePath: summarizeIdentifier(readString(input, 'packagePath') ?? readString(target, 'packagePath')),
    webhookPath: summarizeIdentifier(readString(input, 'webhookPath')),
    sessionKey: summarizeIdentifier(readString(input, 'sessionKey')),
    promptRunId: summarizeIdentifier(readString(input, 'promptRunId')),
    sourceType: readString(input, 'sourceType'),
    phase: readString(input, 'phase'),
    decision: readString(input, 'decision'),
    event: readString(input, 'event'),
  };
}

function summarizeTeamRuntimeResult(result: unknown): string {
  if (!isRecord(result)) return 'invalid';
  if (typeof result.outcome === 'string') return `outcome:${result.outcome}`;
  if (result.success === true && typeof result.outcome === 'string') return `success:${result.outcome}`;
  if (Array.isArray(result.runs)) return 'run-list';
  if (isRecord(result.diagnostics)) return 'snapshot';
  if (result.status === 'valid' || result.status === 'invalid' || result.status === 'unavailable') return `package:${result.status}`;
  if (typeof result.managedAgentCount === 'number') return 'provisioned';
  if (typeof result.yaml === 'string') return 'graph-yaml';
  if (Array.isArray(result.triggers)) return 'trigger-list';
  return 'operation-result';
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

async function executeOpenClawBrowserCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
): Promise<{ status: number; body: unknown }> {
  if (!isOpenClawBrowserRequest(body)) {
    return { status: 400, body: OPENCLAW_BROWSER_REQUEST_INVALID };
  }
  try {
    const response = await deps.runtimeHostTransports.openClawGatewayTransport.execute(body);
    return projectOpenClawGatewayResponse(response, OPENCLAW_BROWSER_REQUEST_INVALID, OPENCLAW_BROWSER_UNAVAILABLE);
  } catch {
    return { status: 503, body: OPENCLAW_BROWSER_UNAVAILABLE };
  }
}

async function executeOpenClawMcpAppCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
): Promise<{ status: number; body: unknown }> {
  if (!isOpenClawMcpAppRequest(body)) {
    return { status: 400, body: OPENCLAW_MCP_APP_REQUEST_INVALID };
  }
  try {
    const response = await deps.runtimeHostTransports.openClawGatewayTransport.execute(body);
    return projectOpenClawGatewayResponse(response, OPENCLAW_MCP_APP_REQUEST_INVALID, OPENCLAW_MCP_APP_UNAVAILABLE);
  } catch {
    return { status: 503, body: OPENCLAW_MCP_APP_UNAVAILABLE };
  }
}

function projectOpenClawGatewayResponse(
  response: { status: number; body: unknown },
  invalidBody: unknown,
  unavailableBody: unknown,
): { status: number; body: unknown } {
  if (response.status === 200) return response;
  if (response.status === 400) return { status: 400, body: invalidBody };
  if (response.status === 409) return { status: 409, body: unavailableBody };
  return { status: 503, body: unavailableBody };
}

async function executePluginRuntimeCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
): Promise<{ status: number; body: unknown }> {
  if (!isPluginCapabilityRequest(body)) {
    return { status: 400, body: CAPABILITY_REJECTED };
  }
  try {
    const response = await deps.runtimeHostTransports.pluginsTransport.configuration({
      runtime: 'openclaw',
      pluginId: body.target.pluginId,
      enabled: body.input.enabled,
    });
    if (response.outcome === 'configured') {
      return { status: 200, body: { outcome: 'configured' } };
    }
    if (response.outcome === 'rejected') {
      return { status: 409, body: { outcome: 'rejected' } };
    }
    return { status: 503, body: PLUGIN_RUNTIME_UNAVAILABLE };
  } catch {
    return { status: 503, body: PLUGIN_RUNTIME_UNAVAILABLE };
  }
}

function isPluginCapabilityRequest(body: Record<string, unknown>): body is PluginRuntimeCapabilityRequest {
  return hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    && body.id === 'plugin.runtime'
    && body.operationId === 'plugins.setEnabled'
    && isNativeRuntimeScope(body.scope)
    && isRecord(body.target)
    && hasExactKeys(body.target, ['kind', 'pluginId'])
    && body.target.kind === 'plugin'
    && typeof body.target.pluginId === 'string'
    && isRecord(body.input)
    && hasExactKeys(body.input, ['enabled', 'pluginIds'])
    && typeof body.input.enabled === 'boolean'
    && Array.isArray(body.input.pluginIds)
    && body.input.pluginIds.length === 1
    && body.input.pluginIds[0] === body.target.pluginId;
}

function isOpenClawBrowserRequest(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'openclaw.browser'
    && value.operationId === 'browser.request'
    && isNativeRuntimeScope(value.scope)
    && value.target === null
    && isOpenClawBrowserInput(value.input);
}

function isOpenClawBrowserInput(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['method', 'path', 'query', 'body', 'timeoutMs', 'target', 'node'])
    && Object.hasOwn(value, 'method')
    && Object.hasOwn(value, 'path')
    && isNonEmptyText(value.method)
    && isNonEmptyText(value.path)
    && (value.query === undefined || (isRecord(value.query) && isRuntimeJsonValue(value.query)))
    && (value.body === undefined || isRuntimeJsonValue(value.body))
    && (value.timeoutMs === undefined || isSafePositiveInteger(value.timeoutMs))
    && (value.target === undefined || value.target === 'host' || value.target === 'node')
    && (value.node === undefined || (value.target === 'node' && isNonEmptyText(value.node)));
}

function isOpenClawMcpAppRequest(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'openclaw.mcpApp'
    && isMcpAppOperationId(value.operationId)
    && isNativeRuntimeScope(value.scope)
    && value.target === null
    && isOpenClawMcpAppInput(value.input);
}

function isOpenClawMcpAppInput(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['sessionKey', 'viewId', 'standalone'])
    && Object.hasOwn(value, 'sessionKey')
    && Object.hasOwn(value, 'viewId')
    && isNonEmptyText(value.sessionKey)
    && isNonEmptyText(value.viewId)
    && (value.standalone === undefined || typeof value.standalone === 'boolean');
}

function isMcpAppOperationId(value: unknown): value is string {
  return isNonEmptyText(value) && value.startsWith('mcp.app.');
}

function isRuntimeJsonValue(value: unknown, seen = new Set<object>()): value is RuntimeHostJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;

  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isRuntimeJsonValue(entry, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return false;
  }
  return Object.values(value).every((entry) => isRuntimeJsonValue(entry, seen));
}

function isNativeRuntimeScope(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint'])
    && value.kind === 'runtime-instance'
    && isRecord(value.endpoint)
    && hasExactKeys(value.endpoint, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.endpoint.kind === 'native-runtime'
    && value.endpoint.runtimeAdapterId === 'openclaw'
    && value.endpoint.runtimeInstanceId === 'local';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isNonEmptyText(entry));
}

function decodeCronTriggerJobId(value: unknown): string | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'scheduler.cron'
    || value.operationId !== 'cron.trigger'
    || !isRecord(value.scope)
    || !hasExactKeys(value.scope, ['kind', 'endpoint'])
    || value.scope.kind !== 'runtime-instance'
    || !isRecord(value.scope.endpoint)
    || !hasExactKeys(value.scope.endpoint, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    || value.scope.endpoint.kind !== 'native-runtime'
    || value.scope.endpoint.runtimeAdapterId !== 'openclaw'
    || value.scope.endpoint.runtimeInstanceId !== 'local'
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind', 'jobId'])
    || value.target.kind !== 'cron-job'
    || !isNonEmptyText(value.target.jobId)
    || !isRecord(value.input)
    || !hasExactKeys(value.input, ['id'])
    || !isNonEmptyText(value.input.id)
    || value.input.id.trim().length === 0
    || value.input.id !== value.target.jobId) {
    return null;
  }
  return value.input.id;
}

function decodeCronTriggerResult(
  value: unknown,
): { success: true; result: {
  outcome: 'accepted' | 'skipped';
  reason?: 'already-running' | 'not-due' | 'invalid-spec' | 'disabled' | 'stopped';
} } | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['success', 'result'])
    || value.success !== true
    || !isRecord(value.result)
    || !hasOnlyKeys(value.result, ['outcome', 'reason'])
    || !Object.hasOwn(value.result, 'outcome')
    || (value.result.outcome !== 'accepted'
      && value.result.outcome !== 'skipped')
    || (value.result.reason !== undefined
      && !isCronTriggerSkipReason(value.result.reason))) {
    return null;
  }
  if (value.result.outcome !== 'skipped' && value.result.reason !== undefined) {
    return null;
  }
  return {
    success: true,
    result: {
      outcome: value.result.outcome,
      ...(value.result.reason === undefined ? {} : { reason: value.result.reason }),
    },
  };
}

function isCronTriggerSkipReason(value: unknown): value is 'already-running' | 'not-due' | 'invalid-spec' | 'disabled' | 'stopped' {
  return value === 'already-running' || value === 'not-due' || value === 'invalid-spec' || value === 'disabled' || value === 'stopped';
}

function isCapabilityDescribeRequest(
  value: unknown,
): value is { id: string; scope: RuntimeScope } {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'scope'])
    && isNonEmptyText(value.id)
    && validateRuntimeScope(value.scope) === null;
}

function isProviderRoutingRequest(value: Record<string, unknown>): boolean {
  if (value.id !== 'provider.routing'
    || (value.operationId !== 'providerRouting.list' && value.operationId !== 'providerRouting.replace')
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || !isProviderRoutingScope(value.scope)
    || !isProviderRoutingScope(value.target)
    || !isRecord(value.input)) {
    return false;
  }
  return value.operationId === 'providerRouting.list'
    ? hasExactKeys(value.input, ['kind']) && value.input.kind === 'list'
    : hasExactKeys(value.input, ['kind', 'routing'])
      && value.input.kind === 'replace'
      && isRouting(value.input.routing);
}

function isProviderRoutingScope(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'provider-routing';
}

function isProviderRoutingResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (hasExactKeys(value, ['success', 'error']) && value.success === false && typeof value.error === 'string') {
    return value.error === PROVIDER_ROUTING_INVALID.error
      || value.error === PROVIDER_ROUTING_UNAVAILABLE.error
      || value.error === 'Provider routing request was rejected';
  }
  if (hasExactKeys(value, ['routing'])) return value.routing === null || isRouting(value.routing);
  return hasExactKeys(value, ['desired', 'configuration'])
    && isRecord(value.desired)
    && hasExactKeys(value.desired, ['status', 'revision'])
    && value.desired.status === 'stored'
    && isSafePositiveInteger(value.desired.revision)
    && isRecord(value.configuration)
    && ((hasExactKeys(value.configuration, ['status']) && value.configuration.status === 'unavailable')
      || (hasExactKeys(value.configuration, ['status', 'changed'])
        && value.configuration.status === 'written'
        && typeof value.configuration.changed === 'boolean'));
}

function isRouting(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['revision', 'routes'])
    && isSafePositiveInteger(value.revision)
    && Array.isArray(value.routes)
    && value.routes.every(isRoutingRoute);
}

function isRoutingRoute(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['capability', 'primary', 'fallbacks', 'timeoutMs'])
    && isRoutingCapability(value.capability)
    && isModelReference(value.primary)
    && Array.isArray(value.fallbacks)
    && value.fallbacks.every(isModelReference)
    && (value.timeoutMs === undefined || isSafePositiveInteger(value.timeoutMs));
}

function isModelReference(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['accountId', 'modelId'])
    && isNonEmptyText(value.accountId)
    && isNonEmptyText(value.modelId);
}

function isRoutingCapability(value: unknown): boolean {
  return value === 'chat' || value === 'imageUnderstand' || value === 'imageGenerate'
    || value === 'videoGenerate' || value === 'musicGenerate' || value === 'tts';
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isTaskOperation(value: unknown): value is TaskOperation {
  return typeof value === 'string' && Object.hasOwn(taskDispatch, value);
}

function isTaskCapabilityRequest(value: Record<string, unknown>, operation: TaskOperation): boolean {
  return value.id === 'task.management'
    && value.operationId === operation
    && isRecord(value.scope)
    && hasExactKeys(value.scope, ['kind', 'identity'])
    && value.scope.kind === 'session'
    && isTaskIdentity(value.scope.identity)
    && isRecord(value.target)
    && hasExactKeys(value.target, ['kind', 'identity'])
    && value.target.kind === 'task-manager'
    && isTaskIdentity(value.target.identity)
    && sameTaskIdentity(value.scope.identity, value.target.identity)
    && isRecord(value.input)
    && isTaskInput(value.input, operation)
    && isTaskIdentity(value.input.sessionIdentity)
    && sameTaskIdentity(value.scope.identity, value.input.sessionIdentity);
}

function isTaskInput(value: Record<string, unknown>, operation: TaskOperation): boolean {
  const allowed: Record<TaskOperation, readonly string[]> = {
    'tasks.list': ['sessionIdentity', 'teamKey'],
    'tasks.get': ['sessionIdentity', 'teamKey', 'taskId'],
    'tasks.create': ['sessionIdentity', 'teamKey', 'subject', 'description', 'activeForm', 'metadata', 'owner'],
    'tasks.update': ['sessionIdentity', 'teamKey', 'taskId', 'status', 'subject', 'description', 'activeForm', 'metadata', 'owner', 'addBlockedBy', 'addBlocks'],
    'todos.get': ['sessionIdentity'],
    'todos.write': ['sessionIdentity', 'oldTodos', 'newTodos'],
  };
  if (!Object.keys(value).every((key) => allowed[operation].includes(key))) return false;
  if (value.teamKey !== undefined && !isNonEmptyText(value.teamKey)) return false;
  if ((operation === 'tasks.get' || operation === 'tasks.update') && !isNonEmptyText(value.taskId)) return false;
  if (operation === 'tasks.create' && (!isNonEmptyText(value.subject) || !isNonEmptyText(value.description))) return false;
  if (value.activeForm !== undefined && !isNonEmptyText(value.activeForm)) return false;
  if (Object.hasOwn(value, 'metadata') && !isRecord(value.metadata)) return false;
  if (value.owner !== undefined && !isNonEmptyText(value.owner)) return false;
  if (value.status !== undefined && !['pending', 'in_progress', 'completed', 'deleted'].includes(value.status as string)) return false;
  if (value.addBlockedBy !== undefined && !isStringArray(value.addBlockedBy)) return false;
  if (value.addBlocks !== undefined && !isStringArray(value.addBlocks)) return false;
  return operation !== 'todos.write' || (isTodos(value.oldTodos) && isTodos(value.newTodos));
}

function isTaskIdentity(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isRecord(value.endpoint)
    && hasExactKeys(value.endpoint, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.endpoint.kind === 'native-runtime'
    && value.endpoint.runtimeAdapterId === 'openclaw'
    && value.endpoint.runtimeInstanceId === 'local'
    && isNonEmptyText(value.agentId)
    && isNonEmptyText(value.sessionKey);
}

function sameTaskIdentity(left: unknown, right: unknown): boolean {
  return isTaskIdentity(left) && isTaskIdentity(right)
    && JSON.stringify(left) === JSON.stringify(right);
}

function isTodos(value: unknown): boolean {
  return Array.isArray(value) && value.every((todo) => isRecord(todo)
    && hasOnlyKeys(todo, ['id', 'content', 'activeForm', 'status', 'owner'])
    && isNonEmptyText(todo.content)
    && ['pending', 'in_progress', 'completed', 'deleted'].includes(todo.status as string)
    && (todo.id === undefined || isNonEmptyText(todo.id))
    && (todo.activeForm === undefined || isNonEmptyText(todo.activeForm))
    && (todo.owner === undefined || isNonEmptyText(todo.owner)));
}

function isTaskManagerResponse(value: unknown, operation: TaskOperation): boolean {
  if (!isRecord(value)) return false;
  if (hasExactKeys(value, ['success', 'error'])) {
    return value.success === false
      && (value.error === TASK_MANAGER_UNAVAILABLE.error || value.error === 'Task manager request was rejected');
  }
  if (operation === 'tasks.list') return isTaskSnapshot(value);
  if (operation === 'tasks.get') return hasExactKeys(value, ['task']) && isTask(value.task);
  if (operation === 'todos.get') return isTodoSnapshot(value);
  if (operation === 'todos.write') {
    return (hasExactKeys(value, ['outcome', 'snapshot'])
      && value.outcome === 'applied'
      && isTodoSnapshot(value.snapshot)
      && isNonNegativeSafeInteger(value.snapshot.updatedAt))
      || isClosedTaskMutation(value);
  }
  if (operation === 'tasks.create') {
    return (hasExactKeys(value, ['outcome', 'task', 'snapshot'])
      && value.outcome === 'applied'
      && isTask(value.task)
      && isTaskSnapshot(value.snapshot))
      || isClosedTaskMutation(value);
  }
  return (hasExactKeys(value, ['outcome', 'snapshot'])
    && value.outcome === 'applied'
    && isTaskSnapshot(value.snapshot))
    || isClosedTaskMutation(value);
}

function isClosedTaskMutation(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['outcome']) && (value.outcome === 'rejected' || value.outcome === 'unknown');
}

function isTaskSnapshot(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['tasks', 'todos'])
    && Array.isArray(value.tasks)
    && value.tasks.every(isTask)
    && Array.isArray(value.todos)
    && value.todos.every(isTodo);
}

function isTodoSnapshot(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && hasOnlyKeys(value, ['todos', 'updatedAt'])
    && Array.isArray(value.todos)
    && value.todos.every(isTodo)
    && (!Object.hasOwn(value, 'updatedAt') || isNonNegativeSafeInteger(value.updatedAt));
}

function isTask(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['id', 'subject', 'description', 'status', 'blockedBy', 'blocks', 'activeForm', 'metadata', 'owner', 'createdAt', 'updatedAt'])
    && isNonEmptyText(value.id)
    && isNonEmptyText(value.subject)
    && isNonEmptyText(value.description)
    && ['pending', 'in_progress', 'completed', 'deleted'].includes(value.status as string)
    && isStringArray(value.blockedBy)
    && isStringArray(value.blocks)
    && isNonNegativeSafeInteger(value.createdAt)
    && isNonNegativeSafeInteger(value.updatedAt)
    && (value.activeForm === undefined || isNonEmptyText(value.activeForm))
    && (!Object.hasOwn(value, 'metadata') || isRecord(value.metadata))
    && (value.owner === undefined || isNonEmptyText(value.owner));
}

function isTodo(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['id', 'content', 'activeForm', 'status', 'owner'])
    && isNonEmptyText(value.content)
    && ['pending', 'in_progress', 'completed', 'deleted'].includes(value.status as string)
    && (value.id === undefined || isNonEmptyText(value.id))
    && (value.activeForm === undefined || isNonEmptyText(value.activeForm))
    && (value.owner === undefined || isNonEmptyText(value.owner));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => hasOwn(value, key));
}
