import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  validateRuntimeScope,
  type RuntimeScope,
} from '../../../src/types/desktop/runtime-address';
import { isBrowserRequestInput } from '../../../src/types/openclaw-browser';
import { isOpenClawSurfaceCapabilityRequest } from '../../main/runtime-host-delivery/transport/openclaw-gateway';
import type { RuntimeHostTransportContext } from '../context';
import { dispatchSessionCapability, type SessionCapabilityRouteDeps } from './sessions';
import { SESSION_PAGE_HEADER } from '../../main/renderer-event-routes';
import {
  isSessionTraceEnabled,
  logSessionTrace,
  readTraceHeader,
  summarizeIdentifier,
} from '../../main/runtime-host-delivery/transport/sessions/trace';
import { isTeamRuntimeCapabilityRequest } from './team-runtime-capability';
import { parseJsonBody, sendJson } from '../route-utils';
import type { TaskManagerTransport } from '../../main/runtime-host-delivery/transport/task-manager';
import { logger } from '../../utils/logger';
import { decodeTaskFailure, decodeTaskFailureResponse, taskFailureResponse, type TaskFailure } from '../../../src/types/desktop/task-failure';
import { decodeCallReceipt } from '../../../src/types/call-log/receipt';
import {
  isOpenClawQuestionListInput,
  isOpenClawQuestionResolveInput,
} from '../../../src/types/openclaw-question';
import type { SessionPage } from '../../main/renderer-event-routes';
import { decodeSessionQuestionRequest, SESSION_QUESTION_INVALID } from '../../main/runtime-host-delivery/transport/sessions/questions';
import { isNativePolicyRequest } from '../../../src/types/native-policy';
import {
  NATIVE_POLICY_INVALID,
  NATIVE_POLICY_OUTCOME_UNKNOWN,
  NATIVE_POLICY_UNAVAILABLE,
} from '../../main/runtime-host-delivery/transport/security/native-policy';

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
const OPENCLAW_SURFACE_REQUEST_INVALID = {
  error: { code: 'SURFACE_INVALID_REQUEST', message: 'Runtime surface request is invalid' },
} as const;
const OPENCLAW_SURFACE_UNAVAILABLE = {
  error: { code: 'SURFACE_UNAVAILABLE', message: 'Runtime surface is unavailable' },
} as const;
const OPENCLAW_QUESTION_REQUEST_INVALID = {
  success: false,
  error: 'OpenClaw question request is invalid',
} as const;
const OPENCLAW_QUESTION_UNAVAILABLE = {
  success: false,
  error: 'OpenClaw question request is unavailable',
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
    | 'sessionQuestionTransport'
    | 'nativePolicyTransport'
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

  const traceId = readTraceHeader(req.headers);
  const traceStartedAt = traceId && isSessionTraceEnabled() ? Date.now() : 0;
  const trace = (stage: string, payload?: () => Record<string, unknown>): void => {
    if (!traceStartedAt) return;
    logSessionTrace(`electron.hostapi.capability.${stage}`, traceId, {
      path: '/api/capabilities/execute', elapsedMs: Date.now() - traceStartedAt, ...payload?.(),
    });
  };
  let body: unknown;
  trace('parse.start');
  try {
    body = await parseJsonBody<unknown>(req);
    trace('parse.end', () => ({ outcome: 'parsed' }));
  } catch {
    trace('parse.end', () => ({ outcome: 'failed', status: 500 }));
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
    logSessionTrace('capability.subagent.configuration.dispatch', traceId, () => summarizeSubagentConfigurationRequest(body));
    try {
      const response = await deps.runtimeHostTransports.agentsTransport.execute(body, traceId);
      logSessionTrace('capability.subagent.configuration.response', traceId, () => ({
        status: response.status,
        contract: summarizeSubagentConfigurationResponse(response.body),
      }));
      sendJson(res, response.status, response.body);
    } catch {
      logSessionTrace('capability.subagent.configuration.failure', traceId);
      sendJson(res, 503, SUBAGENT_CONFIGURATION_UNAVAILABLE);
    }
    return true;
  }

  const sessionController = new AbortController();
  const cancelSessionObservation = (): void => {
    if (res.closed && !res.writableFinished) sessionController.abort();
  };
  res.once('close', cancelSessionObservation);
  cancelSessionObservation();
  try {
    trace('session-dispatch.start');
    const sessionResponse = await dispatchSessionCapability(body, deps, readTraceHeader(req.headers),
      deps.sessionObservers.resolve(req.headers[SESSION_PAGE_HEADER.toLowerCase()]), sessionController.signal);
    trace('session-dispatch.end', () => ({
      outcome: sessionController.signal.aborted ? 'aborted' : sessionResponse ? 'handled' : 'unhandled',
      status: sessionResponse?.status ?? null,
    }));
    if (sessionResponse) {
      if (!sessionController.signal.aborted) sendJson(res, sessionResponse.status, sessionResponse.body);
      return true;
    }
  } catch {
    trace('session-dispatch.end', () => ({
      outcome: sessionController.signal.aborted ? 'aborted' : 'failed',
      status: sessionController.signal.aborted ? null : 500,
    }));
    if (!sessionController.signal.aborted) sendJson(res, 500, CAPABILITY_REQUEST_FAILED);
    return true;
  } finally {
    res.removeListener('close', cancelSessionObservation);
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
      } else if (response.status === 422) {
        sendJson(res, 200, { success: true, result: { outcome: 'failed' } });
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

  if (body.id === 'security.nativePolicy') {
    if (!isNativePolicyRequest(body)) {
      sendJson(res, 400, NATIVE_POLICY_INVALID);
      return true;
    }
    try {
      const response = await deps.runtimeHostTransports.nativePolicyTransport.execute(body);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, body.operationId.endsWith('.set') || body.operationId === 'nativePolicy.result'
        ? NATIVE_POLICY_OUTCOME_UNKNOWN : NATIVE_POLICY_UNAVAILABLE);
    }
    return true;
  }

  if (body.id === 'session.question') {
    const response = await executeSessionQuestionCapability(body, deps,
      deps.sessionObservers.resolve(req.headers[SESSION_PAGE_HEADER.toLowerCase()]));
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'openclaw.browser') {
    const response = await executeOpenClawBrowserCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'openclaw.mcpApp' || body.id === 'openclaw.canvas' || body.id === 'openclaw.progress') {
    const response = await executeOpenClawSurfaceCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'openclaw.question') {
    const response = await executeOpenClawQuestionCapability(body, deps,
      deps.sessionObservers.resolve(req.headers[SESSION_PAGE_HEADER.toLowerCase()]));
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'team.runtime') {
    const traceId = readTraceHeader(req.headers);
    logSessionTrace('electron.team.runtime.request', traceId, () => summarizeTeamRuntimeRequest(body));
    if (!isTeamRuntimeCapabilityRequest(body)) {
      logSessionTrace('electron.team.runtime.request-invalid', traceId, () => summarizeTeamRuntimeRequest(body));
      sendJson(res, 400, TEAM_RUNTIME_REQUEST_INVALID);
      return true;
    }
    try {
      logSessionTrace('electron.team.runtime.transport.request', traceId, () => summarizeTeamRuntimeRequest(body));
      const response = await deps.runtimeHostTransports.teamRuntimeTransport.execute(body, traceId ?? undefined);
      logSessionTrace('electron.team.runtime.transport.response', traceId, () => ({
        status: response.status,
        contract: summarizeTeamRuntimeResult(response.body),
      }));
      logSessionTrace('electron.team.runtime.response', traceId, () => ({
        status: response.status,
        contract: response.status === 202 ? 'admission' : response.status === 200 ? 'operation-result' : 'unavailable',
      }));
      sendJson(res, response.status, response.body);
    } catch {
      logSessionTrace('electron.team.runtime.failure', traceId);
      sendJson(res, 503, TEAM_RUNTIME_UNAVAILABLE);
    }
    return true;
  }

  if (body.id === 'skill.management') {
    const traceId = body.operationId === 'clawhub.openPath' ? readTraceHeader(req.headers) : null;
    logSessionTrace('skill.open-path.main.received', traceId);
    try {
      const response = await deps.runtimeHostTransports.skillsManagementTransport.execute(body, traceId);
      logSessionTrace('skill.open-path.main.response', traceId, () => ({ status: response.status }));
      sendJson(res, response.status, response.body);
    } catch {
      logSessionTrace('skill.open-path.main.failed', traceId);
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
      if (!isProviderRoutingResponse(response.body, response.status, body.operationId)) {
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
    const fail = (status: 400 | 503, failure: TaskFailure) => {
      logger.warn('[TaskManager] Capability request failed', { operation, status, ...failure });
      sendJson(res, status, taskFailureResponse(failure));
    };
    if (!operation || !isTaskCapabilityRequest(body, operation)) {
      fail(400, { stage: 'task_request', code: 'invalid_params', delivery: 'notSent' });
      return true;
    }
    try {
      const response = await deps.runtimeHostTransports.taskManagerTransport[taskDispatch[operation]](body);
      if (!isTaskManagerResponse(response.body, response.status, operation)) {
        fail(503, { stage: 'response', code: 'protocol', delivery: 'responseReceived' });
      } else {
        sendJson(res, response.status, decodeTaskFailureResponse(response.body) ?? response.body);
      }
    } catch {
      fail(503, { stage: 'transport', code: 'transport', delivery: 'unknown' });
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
    return await deps.runtimeHostTransports.openClawGatewayTransport.execute(body);
  } catch {
    return { status: 503, body: isRecord(body.input) && body.input.method !== 'GET'
      ? { outcome: 'unknown' } : OPENCLAW_BROWSER_UNAVAILABLE };
  }
}

async function executeOpenClawSurfaceCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
): Promise<{ status: number; body: unknown }> {
  if (!isOpenClawSurfaceCapabilityRequest(body)) {
    return { status: 400, body: OPENCLAW_SURFACE_REQUEST_INVALID };
  }
  try {
    return await deps.runtimeHostTransports.openClawGatewayTransport.execute(body);
  } catch {
    return { status: 503, body: body.operationId === 'mcp.app.callTool' || body.operationId === 'mcp.app.updateModelContext'
      ? { error: { code: 'SURFACE_OUTCOME_UNKNOWN', message: 'Runtime surface operation outcome is unknown' } }
      : OPENCLAW_SURFACE_UNAVAILABLE };
  }
}

async function executeSessionQuestionCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
  page: SessionPage | undefined,
): Promise<{ status: number; body: unknown }> {
  const request = decodeSessionQuestionRequest(body);
  if (!request || !deps.sessionObservers.isCurrent(page)) {
    return { status: 400, body: SESSION_QUESTION_INVALID };
  }
  try {
    const response = await deps.runtimeHostTransports.sessionQuestionTransport.execute(request);
    if (!deps.sessionObservers.isCurrent(page)) return { status: 400, body: SESSION_QUESTION_INVALID };
    return response;
  } catch {
    if (!deps.sessionObservers.isCurrent(page)) return { status: 400, body: SESSION_QUESTION_INVALID };
    return { status: 503, body: { outcome: request.operationId === 'sessions.questions.respond' ? 'unknown' : 'unavailable' } };
  }
}

async function executeOpenClawQuestionCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
  page: SessionPage | undefined,
): Promise<{ status: number; body: unknown }> {
  if (!deps.sessionObservers.isCurrent(page) || !isOpenClawQuestionRequest(body)) {
    return { status: 400, body: OPENCLAW_QUESTION_REQUEST_INVALID };
  }
  try {
    const response = await deps.runtimeHostTransports.openClawGatewayTransport.execute(body);
    if (!deps.sessionObservers.isCurrent(page)) return { status: 400, body: OPENCLAW_QUESTION_REQUEST_INVALID };
    return projectOpenClawGatewayResponse(response, OPENCLAW_QUESTION_REQUEST_INVALID, OPENCLAW_QUESTION_UNAVAILABLE);
  } catch {
    return { status: 503, body: OPENCLAW_QUESTION_UNAVAILABLE };
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
    return { status: 202, body: response };
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
    && isBrowserRequestInput(value.input);
}

function isOpenClawQuestionRequest(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'openclaw.question'
    && isNativeRuntimeScope(value.scope)
    && value.target === null
    && ((value.operationId === 'question.list' && isOpenClawQuestionListInput(value.input))
      || (value.operationId === 'question.resolve' && isOpenClawQuestionResolveInput(value.input)));
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
    || (value.scope.endpoint.runtimeAdapterId !== 'openclaw' && value.scope.endpoint.runtimeAdapterId !== 'matcha-agent')
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

function isProviderRoutingResponse(value: unknown, status: number, operation: unknown): boolean {
  if (status === 202 && operation === 'providerRouting.replace') {
    decodeCallReceipt(value);
    return true;
  }
  if (!isRecord(value)) return false;
  if (hasExactKeys(value, ['success', 'error']) && value.success === false && typeof value.error === 'string') {
    return value.error === PROVIDER_ROUTING_INVALID.error
      || value.error === PROVIDER_ROUTING_UNAVAILABLE.error
      || value.error === 'Provider routing request was rejected';
  }
  return status === 200 && operation === 'providerRouting.list'
    && hasExactKeys(value, ['routing'])
    && (value.routing === null || isRouting(value.routing));
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
    && (value.endpoint.runtimeAdapterId === 'openclaw' || value.endpoint.runtimeAdapterId === 'matcha-agent')
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

function isTaskManagerResponse(value: unknown, status: number, operation: TaskOperation): boolean {
  if (!isRecord(value)) return false;
  if (status === 409 || status === 503) {
    return decodeTaskFailureResponse(value) !== null || (hasExactKeys(value, ['success', 'error'])
      && value.success === false
      && (value.error === TASK_MANAGER_UNAVAILABLE.error || value.error === 'Task manager request was rejected'));
  }
  if (status !== 200) return false;
  if (operation === 'tasks.list') return isTaskSnapshot(value);
  if (operation === 'tasks.get') return hasExactKeys(value, ['task']) && (value.task === null || isTask(value.task));
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
  return (hasExactKeys(value, ['outcome']) || (hasExactKeys(value, ['outcome', 'failure']) && decodeTaskFailure(value.failure) !== null))
    && (value.outcome === 'rejected' || value.outcome === 'unknown');
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
