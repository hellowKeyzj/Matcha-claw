import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CapabilityDescriptor } from '../../desktop-contract/capability-descriptor';
import {
  buildCapabilityScopeKey,
  validateRuntimeScope,
  type RuntimeScope,
} from '../../desktop-contract/runtime-address';
import {
  RuntimeHostControlError,
  type RuntimeHostControlOutcome,
} from '../../main/runtime-host-delivery/control';
import {
  decodeSkillsStatus,
  projectSkillsStatus,
} from '../../main/runtime-host-delivery/transport/skills/management';
import type { HostApiContext } from '../context';
import { dispatchSessionCapability, type SessionCapabilityRouteDeps } from './sessions';
import { readTraceHeader } from '../../main/runtime-host-delivery/transport/sessions/trace';
import { isTeamRuntimeCapabilityRequest } from './team-runtime-capability';
import { parseJsonBody, sendJson } from '../route-utils';
import type {
  TaskManagerTransport,
  TaskManagerTransportResponse,
} from '../../main/runtime-host-delivery/transport/task-manager';

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
const TASK_MANAGER_REJECTED = {
  success: false,
  error: 'Task manager request was rejected',
} as const;
const TEAM_RUNTIME_REQUEST_INVALID = {
  success: false,
  error: 'Team runtime request is invalid',
} as const;
const TEAM_RUNTIME_UNAVAILABLE = {
  success: false,
  error: 'Team runtime operation is unavailable',
} as const;
const TOOLCHAIN_REQUEST_INVALID = {
  success: false,
  error: 'Toolchain request is invalid',
} as const;
const TOOLCHAIN_UNAVAILABLE = {
  success: false,
  error: 'Toolchain is unavailable',
} as const;
const RUNTIME_HOST_REQUEST_INVALID = {
  success: false,
  error: 'Runtime host request is invalid',
} as const;
const RUNTIME_HOST_UNAVAILABLE = {
  success: false,
  error: 'Runtime host is unavailable',
} as const;
const TOOLCHAIN_JOB_TYPE = 'toolchain.uvInstall';
const TOOLCHAIN_JOB_ID_PREFIX = 'runtime-host:openclaw:toolchain:';
const TOOLCHAIN_PROGRESS_MESSAGE = 'Installing uv Python runtime';
const TOOLCHAIN_ERROR_MESSAGES = [
  'Toolchain installation is unavailable.',
  'Toolchain installation was cancelled.',
] as const;
const TOOLCHAIN_JOB_RESULTS = ['installed', 'rejected', 'unknown', 'unavailable'] as const;

const LEGACY_TASK_METHODS = [
  'TaskList',
  'TaskGet',
  'TaskCreate',
  'TaskUpdate',
  'TodoGet',
  'TodoWrite',
] as const;
type LegacyTaskMethod = typeof LEGACY_TASK_METHODS[number];

type CapabilityRouteContext = SessionCapabilityRouteDeps & Pick<
  HostApiContext,
  'licenseService' | 'providerRoutingTransport' | 'taskManagerTransport' | 'runtimeHost' | 'workspaceMediaTransport' | 'agentsTransport'
>;

type TaskOperation =
  | 'tasks.list'
  | 'tasks.get'
  | 'tasks.create'
  | 'tasks.update'
  | 'todos.get'
  | 'todos.write'
  | 'tasks.output'
  | 'tasks.stop';

const taskDispatch: Readonly<Record<TaskOperation, keyof TaskManagerTransport>> = {
  'tasks.list': 'list',
  'tasks.get': 'get',
  'tasks.create': 'create',
  'tasks.update': 'update',
  'todos.get': 'getTodos',
  'todos.write': 'writeTodos',
  'tasks.output': 'output',
  'tasks.stop': 'stop',
};

export async function handleCapabilityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CapabilityRouteContext,
): Promise<boolean> {
  if (url.pathname === '/api/capabilities/list' && req.method === 'GET') {
    try {
      const directory = projectCapabilityDirectory(decodeCapabilityDirectory(
        await deps.runtimeHost.command({ name: 'host.capabilities.list' }),
      ));
      sendJson(res, directory ? 200 : 503, directory ?? CAPABILITY_DIRECTORY_UNAVAILABLE);
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
    if (body.id === LICENSE_RUNTIME_DESCRIPTOR.id) {
      const capability = sameRuntimeScope(LICENSE_RUNTIME_DESCRIPTOR.scope, body.scope)
        ? LICENSE_RUNTIME_DESCRIPTOR
        : null;
      sendJson(
        res,
        capability ? 200 : 404,
        capability ? { capability } : CAPABILITY_NOT_AVAILABLE,
      );
      return true;
    }
    try {
      const outcome = await deps.runtimeHost.command({
        name: 'host.capabilities.describe',
        input: { id: body.id, scope: body.scope },
      });
      if (isInvalidCapabilityRejection(outcome)) {
        sendJson(res, 404, CAPABILITY_NOT_AVAILABLE);
        return true;
      }
      const capability = decodeCapabilityDescribe(outcome, body.id, body.scope);
      sendJson(
        res,
        capability ? 200 : 503,
        capability ? { capability } : CAPABILITY_DIRECTORY_UNAVAILABLE,
      );
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
      const response = await deps.workspaceMediaTransport.execute(body);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, { success: false, error: 'Workspace media is unavailable' });
    }
    return true;
  }

  if (isRecord(body) && isSubagentConfigurationCapabilityId(body.id)) {
    try {
      const response = await deps.agentsTransport.execute(body);
      sendJson(res, response.status, response.body);
    } catch {
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
      const outcome = await deps.runtimeHost.command({
        name: 'openclaw.cron.manual-trigger',
        input: { jobId },
      });
      const result = decodeCronTriggerResult(outcome);
      sendJson(res, result ? 200 : 503, result ?? CRON_SERVICE_UNAVAILABLE);
    } catch (error) {
      if (error instanceof RuntimeHostControlError && error.delivery === 'unknown-delivery') {
        sendJson(res, 200, { success: true, result: { outcome: 'outcome-unknown' } });
      } else {
        sendJson(res, 503, CRON_SERVICE_UNAVAILABLE);
      }
    }
    return true;
  }

  if (!isRecord(body)) {
    sendJson(res, 404, CAPABILITY_NOT_AVAILABLE);
    return true;
  }

  if (body.id === 'team.runtime') {
    if (!isTeamRuntimeCapabilityRequest(body)) {
      sendJson(res, 400, TEAM_RUNTIME_REQUEST_INVALID);
      return true;
    }
    try {
      const outcome = await deps.runtimeHost.command({
        name: 'team.runtime.execute',
        input: body,
      });
      const response = projectTeamRuntimeOutcome(outcome);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, TEAM_RUNTIME_UNAVAILABLE);
    }
    return true;
  }

  if (body.id === 'skill.management') {
    const response = await executeSkillManagementCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'plugin.runtime') {
    const response = await executePluginRuntimeCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'runtime.host') {
    const response = body.operationId === 'runtimeHost.jobGet'
      ? await executeToolchainCapability(body, deps)
      : await executeRuntimeHostCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'platform.runtime') {
    const response = await executeToolchainCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'provider.routing') {
    if (!isProviderRoutingRequest(body)) {
      sendJson(res, 400, PROVIDER_ROUTING_INVALID);
      return true;
    }
    if (!deps.providerRoutingTransport) {
      sendJson(res, 503, PROVIDER_ROUTING_UNAVAILABLE);
      return true;
    }
    try {
      const response = await deps.providerRoutingTransport.execute(body);
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

  if (body.id === 'tool.invoke') {
    const response = await executeLegacyTaskCapability(body, deps);
    sendJson(res, response.status, response.body);
    return true;
  }

  if (body.id === 'task.management' || body.id === 'task.control') {
    const operation = isTaskOperation(body.operationId) ? body.operationId : undefined;
    if (!operation || !isTaskRequest(body, operation)) {
      sendJson(res, 400, TASK_MANAGER_INVALID);
      return true;
    }
    try {
      const response = await deps.taskManagerTransport[taskDispatch[operation]](body);
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

  if (body.id === 'license.runtime') {
    const response = await executeLicenseCapability(body, deps.licenseService);
    sendJson(res, response.status, response.body);
    return true;
  }

  sendJson(res, 404, CAPABILITY_NOT_AVAILABLE);
  return true;
}

type TaskManagementOperation = Exclude<TaskOperation, 'tasks.output' | 'tasks.stop'>;
type TaskIdentity = Record<string, unknown>;

type SkillCapabilityOperation =
  | 'skills.refreshStatus'
  | 'skills.updateConfig'
  | 'skills.updateState'
  | 'skills.updateBatchState'
  | 'skills.exportBundles'
  | 'skills.importBundles'
  | 'clawhub.openReadme'
  | 'clawhub.openPath';

const CAPABILITY_REJECTED = { outcome: 'rejected' } as const;
const SKILL_MANAGEMENT_UNAVAILABLE = { outcome: 'unknown' } as const;
const PLUGIN_RUNTIME_UNAVAILABLE = { outcome: 'unknown' } as const;

function projectTeamRuntimeOutcome(
  outcome: RuntimeHostControlOutcome,
): { status: number; body: unknown } {
  if (outcome.kind === 'succeeded') return { status: 200, body: outcome.result };
  if (outcome.kind === 'unknown') return { status: 200, body: outcome.result };
  if (outcome.kind === 'timed-out') {
    return { status: 503, body: TEAM_RUNTIME_UNAVAILABLE };
  }
  const status = outcome.error.code === 'INVALID_INPUT'
    ? 400
    : outcome.error.code === 'CAPACITY_EXHAUSTED'
      ? 409
      : outcome.error.code === 'UNAVAILABLE'
        ? 503
        : 500;
  return {
    status,
    body: outcome.error.code === 'INVALID_INPUT'
      ? TEAM_RUNTIME_REQUEST_INVALID
      : TEAM_RUNTIME_UNAVAILABLE,
  };
}

type SubagentConfigurationCapabilityId = 'subagent.skills' | 'subagent.tools';

function isSubagentConfigurationCapabilityId(value: unknown): value is SubagentConfigurationCapabilityId {
  return value === 'subagent.skills' || value === 'subagent.tools';
}

async function executeSkillManagementCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
): Promise<{ status: number; body: unknown }> {
  const operation = isSkillCapabilityOperation(body.operationId) ? body.operationId : undefined;
  if (!operation || !isSkillCapabilityRequest(body, operation)) {
    return { status: 400, body: CAPABILITY_REJECTED };
  }
  try {
    const outcome = await deps.runtimeHost.command({
      name: 'openclaw.skills.execute',
      input: {
        id: body.id,
        operationId: operation,
        scope: body.scope,
        target: body.target,
        input: body.input,
      },
    });
    return projectSkillCapabilityOutcome(outcome, operation);
  } catch {
    return { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
}

async function executePluginRuntimeCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
): Promise<{ status: number; body: unknown }> {
  if (!isPluginCapabilityRequest(body)) {
    return { status: 400, body: CAPABILITY_REJECTED };
  }
  try {
    const outcome = await deps.runtimeHost.command({
      name: 'openclaw.plugins.execute',
      input: {
        id: body.id,
        operationId: body.operationId,
        scope: body.scope,
        target: body.target,
        input: body.input,
      },
    });
    if (outcome.kind === 'succeeded' && isRecord(outcome.result)
      && hasExactKeys(outcome.result, ['success', 'outcome'])
      && outcome.result.success === true
      && outcome.result.outcome === 'configured') {
      return { status: 200, body: { outcome: 'configured' } };
    }
    if (outcome.kind === 'rejected' && outcome.error.code === 'INVALID_INPUT') {
      return { status: 400, body: { outcome: 'rejected' } };
    }
    if (outcome.kind === 'rejected' && outcome.error.code === 'FAILED') {
      return { status: 409, body: { outcome: 'rejected' } };
    }
    return { status: 503, body: PLUGIN_RUNTIME_UNAVAILABLE };
  } catch {
    return { status: 503, body: PLUGIN_RUNTIME_UNAVAILABLE };
  }
}

function projectSkillCapabilityOutcome(
  outcome: RuntimeHostControlOutcome,
  operation: SkillCapabilityOperation,
): { status: number; body: unknown } {
  if (outcome.kind === 'unknown') return { status: 503, body: { outcome: 'unknown' } };
  if (outcome.kind === 'timed-out') return { status: 503, body: { outcome: 'unknown' } };
  if (outcome.kind === 'rejected') {
    return { status: outcome.error.code === 'INVALID_INPUT' ? 400 : 503, body: CAPABILITY_REJECTED };
  }
  if (!isRecord(outcome.result)) return { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  if (operation === 'skills.refreshStatus') {
    const native = decodeSkillsStatus(outcome.result);
    return native
      ? { status: 200, body: projectSkillsStatus(native) }
      : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
  if (operation === 'skills.exportBundles') {
    return isRecord(outcome.result)
      && hasExactKeys(outcome.result, ['skillBundles'])
      && Array.isArray(outcome.result.skillBundles)
      ? { status: 200, body: outcome.result.skillBundles }
      : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
  if (operation === 'skills.importBundles') {
    return isRecord(outcome.result) && hasExactKeys(outcome.result, ['ok']) && outcome.result.ok === true
      ? { status: 200, body: { ok: true } }
      : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
  if (operation === 'clawhub.openReadme' || operation === 'clawhub.openPath') {
    return isRecord(outcome.result)
      && hasExactKeys(outcome.result, ['success', 'content', 'filePath'])
      && outcome.result.success === true
      && typeof outcome.result.content === 'string'
      && typeof outcome.result.filePath === 'string'
      ? { status: 200, body: outcome.result }
      : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
  }
  return isRecord(outcome.result) && outcome.result.success === true
    ? { status: 200, body: { success: true } }
    : { status: 503, body: SKILL_MANAGEMENT_UNAVAILABLE };
}

function isSkillCapabilityOperation(value: unknown): value is SkillCapabilityOperation {
  return value === 'skills.refreshStatus'
    || value === 'skills.updateConfig'
    || value === 'skills.updateState'
    || value === 'skills.updateBatchState'
    || value === 'skills.exportBundles'
    || value === 'skills.importBundles'
    || value === 'clawhub.openReadme'
    || value === 'clawhub.openPath';
}

function isSkillCapabilityRequest(body: Record<string, unknown>, operation: SkillCapabilityOperation): boolean {
  return hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    && body.id === 'skill.management'
    && body.operationId === operation
    && isNativeRuntimeScope(body.scope)
    && isRecord(body.target)
    && isRecord(body.input)
    && targetMatchesSkillOperation(body.target, body.input, operation);
}

function targetMatchesSkillOperation(target: Record<string, unknown>, input: Record<string, unknown>, operation: SkillCapabilityOperation): boolean {
  if (operation === 'skills.refreshStatus') return hasExactKeys(target, ['kind']) && target.kind === 'none' && hasExactKeys(input, []);
  if (operation === 'skills.exportBundles') return hasExactKeys(target, ['kind']) && target.kind === 'skill-bundle' && hasExactKeys(input, ['skillKeys']) && isStringArray(input.skillKeys);
  if (operation === 'skills.importBundles') return hasExactKeys(target, ['kind']) && target.kind === 'skill-bundle' && hasExactKeys(input, ['skillBundles']) && Array.isArray(input.skillBundles);
  if (operation === 'skills.updateBatchState') return hasExactKeys(target, ['kind']) && target.kind === 'skill' && hasExactKeys(input, ['skillKeys', 'enabled']) && isStringArray(input.skillKeys) && typeof input.enabled === 'boolean';
  if (!hasExactKeys(target, ['kind', 'skillId', 'slug']) || target.kind !== 'skill' || typeof target.skillId !== 'string' || typeof target.slug !== 'string') return false;
  if (operation === 'skills.updateConfig') return hasExactKeys(input, ['skillKey', 'apiKey', 'env']) && input.skillKey === target.skillId && typeof input.apiKey === 'string' && isStringRecord(input.env);
  if (operation === 'skills.updateState') return hasExactKeys(input, ['skillKey', 'enabled']) && input.skillKey === target.skillId && typeof input.enabled === 'boolean';
  return input.skillKey === target.skillId
    && (input.slug === undefined || input.slug === target.slug)
    && hasOnlyKeys(input, ['skillKey', 'slug', 'baseDir', 'filePath']);
}

function isPluginCapabilityRequest(body: Record<string, unknown>): boolean {
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

async function executeRuntimeHostCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
): Promise<{ status: number; body: unknown }> {
  if (!isRuntimeHostGatewayControlRequest(body)) {
    return { status: 400, body: RUNTIME_HOST_REQUEST_INVALID };
  }
  try {
    const outcome = await deps.runtimeHost.command({ name: 'host.runtime.execute', input: body });
    return projectRuntimeHostGatewayControlOutcome(outcome);
  } catch {
    return { status: 503, body: RUNTIME_HOST_UNAVAILABLE };
  }
}

function isRuntimeHostGatewayControlRequest(body: Record<string, unknown>): boolean {
  return hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    && body.id === 'runtime.host'
    && isRuntimeHostGatewayControlOperation(body.operationId)
    && isNativeRuntimeScope(body.scope)
    && isRecord(body.target)
    && hasExactKeys(body.target, ['kind'])
    && body.target.kind === 'gateway-control'
    && isRecord(body.input);
}

function isRuntimeHostGatewayControlOperation(value: unknown): boolean {
  return value === 'runtimeHost.prepareGatewayLaunch'
    || value === 'runtimeHost.gatewayLifecycle'
    || value === 'runtimeHost.gatewayReady'
    || value === 'runtimeHost.gatewayControlUiAutoApprove';
}

function projectRuntimeHostGatewayControlOutcome(outcome: RuntimeHostControlOutcome): { status: number; body: unknown } {
  if (outcome.kind === 'succeeded') return { status: 200, body: outcome.result };
  if (outcome.kind === 'rejected' && outcome.error.code === 'INVALID_INPUT') {
    return { status: 400, body: RUNTIME_HOST_REQUEST_INVALID };
  }
  return { status: 503, body: RUNTIME_HOST_UNAVAILABLE };
}

async function executeToolchainCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
): Promise<{ status: number; body: unknown }> {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input']) || !isNativeRuntimeScope(body.scope)) {
    return { status: 400, body: TOOLCHAIN_REQUEST_INVALID };
  }
  if (body.id === 'platform.runtime' && body.operationId === 'toolchain.installUv') {
    if (!isRecord(body.target) || !hasExactKeys(body.target, ['kind']) || body.target.kind !== 'runtime-job'
      || !isRecord(body.input) || !hasExactKeys(body.input, [])) {
      return { status: 400, body: TOOLCHAIN_REQUEST_INVALID };
    }
    try {
      const outcome = await deps.runtimeHost.command({ name: 'openclaw.toolchain.install-submit' });
      const snapshot = decodeToolchainSnapshot(outcome);
      return snapshot ? { status: 202, body: { success: true, job: snapshot } } : { status: 503, body: TOOLCHAIN_UNAVAILABLE };
    } catch {
      return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
    }
  }
  if (body.id === 'runtime.host' && body.operationId === 'runtimeHost.jobGet') {
    const jobId = decodeRuntimeJobId(body);
    if (!jobId) return { status: 400, body: TOOLCHAIN_REQUEST_INVALID };
    try {
      const outcome = await deps.runtimeHost.command({ name: 'openclaw.toolchain.job-get', input: { jobId } });
      const lookup = decodeToolchainLookup(outcome);
      return lookup
        ? { status: 200, body: { success: true, job: lookup.job } }
        : { status: 503, body: TOOLCHAIN_UNAVAILABLE };
    } catch {
      return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
    }
  }
  return { status: 404, body: CAPABILITY_NOT_AVAILABLE };
}

function decodeRuntimeJobId(body: Record<string, unknown>): string | null {
  if (!isRecord(body.target) || !hasExactKeys(body.target, ['kind', 'jobId']) || body.target.kind !== 'runtime-job'
    || !isRuntimeJobId(body.target.jobId) || !isRecord(body.input)
    || !hasExactKeys(body.input, ['jobId']) || body.input.jobId !== body.target.jobId) return null;
  return body.target.jobId;
}

function decodeToolchainLookup(outcome: RuntimeHostControlOutcome): { job: Record<string, unknown> | null } | null {
  if (!isRecord(outcome) || !hasExactKeys(outcome, ['kind', 'result']) || outcome.kind !== 'succeeded'
    || !isRecord(outcome.result) || !hasExactKeys(outcome.result, ['job', 'outcome'])
    || (outcome.result.outcome !== 'known' && outcome.result.outcome !== 'unknown' && outcome.result.outcome !== 'notfound')) return null;
  if (outcome.result.job === null && (outcome.result.outcome === 'unknown' || outcome.result.outcome === 'notfound')) return { job: null };
  if (outcome.result.job === null || outcome.result.outcome !== 'known') return null;
  const job = projectToolchainSnapshot(outcome.result.job);
  return job ? { job } : null;
}

function decodeToolchainSnapshot(outcome: RuntimeHostControlOutcome): Record<string, unknown> | null {
  if (!isRecord(outcome) || !hasExactKeys(outcome, ['kind', 'result']) || outcome.kind !== 'succeeded'
    || !isRecord(outcome.result) || !hasExactKeys(outcome.result, ['job'])) return null;
  return projectToolchainSnapshot(outcome.result.job);
}

function projectToolchainSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['id', 'type', 'status', 'queuedAt', 'startedAt', 'finishedAt', 'attempts', 'maxAttempts', 'progress', 'result', 'error'])
    || !hasOwn(value, 'id')
    || !hasOwn(value, 'type')
    || !hasOwn(value, 'status')
    || !hasOwn(value, 'queuedAt')
    || !hasOwn(value, 'attempts')
    || !hasOwn(value, 'maxAttempts')
    || !isToolchainJobId(value.id)
    || value.type !== TOOLCHAIN_JOB_TYPE
    || !isToolchainJobStatus(value.status)
    || !isNonNegativeSafeInteger(value.queuedAt)
    || !isNonNegativeSafeInteger(value.attempts)
    || !isSafePositiveInteger(value.maxAttempts)
    || value.attempts > value.maxAttempts
    || !isNullableToolchainTimestamp(value, 'startedAt')
    || !isNullableToolchainTimestamp(value, 'finishedAt')) {
    return null;
  }

  const progress = projectToolchainProgress(value.progress);
  if (value.progress !== undefined && value.progress !== null && !progress) return null;
  if (!isNullableToolchainResult(value.result) || !isNullableToolchainError(value.error)) return null;

  return {
    id: value.id,
    type: value.type,
    status: value.status,
    queuedAt: value.queuedAt,
    ...(value.startedAt === undefined || value.startedAt === null ? {} : { startedAt: value.startedAt }),
    ...(value.finishedAt === undefined || value.finishedAt === null ? {} : { finishedAt: value.finishedAt }),
    attempts: value.attempts,
    maxAttempts: value.maxAttempts,
    ...(progress ? { progress } : {}),
    ...(value.result === undefined || value.result === null ? {} : { result: value.result }),
    ...(value.error === undefined || value.error === null ? {} : { error: value.error }),
  };
}

function projectToolchainProgress(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !hasOnlyKeys(value, ['updatedAt', 'percent', 'message'])
    || !hasOwn(value, 'updatedAt')
    || !isNonNegativeSafeInteger(value.updatedAt)
    || (hasOwn(value, 'percent') && !isToolchainProgressPercent(value.percent))
    || (hasOwn(value, 'message') && value.message !== TOOLCHAIN_PROGRESS_MESSAGE)) {
    return null;
  }
  return {
    updatedAt: value.updatedAt,
    ...(value.percent === undefined ? {} : { percent: value.percent }),
    ...(value.message === undefined ? {} : { message: value.message }),
  };
}

function isNullableToolchainTimestamp(value: Record<string, unknown>, key: string): boolean {
  return !hasOwn(value, key) || value[key] === null || isNonNegativeSafeInteger(value[key]);
}

function isNullableToolchainResult(value: unknown): boolean {
  return value === undefined || value === null || isToolchainJobResult(value);
}

function isNullableToolchainError(value: unknown): boolean {
  return value === undefined || value === null || isToolchainError(value);
}

function isRuntimeJobId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 128
    && !hasControlCharacter(value)
    && !/\s/.test(value);
}

function isToolchainJobId(value: unknown): value is string {
  return isRuntimeJobId(value)
    && value.startsWith(TOOLCHAIN_JOB_ID_PREFIX)
    && /^\d+$/.test(value.slice(TOOLCHAIN_JOB_ID_PREFIX.length));
}

function isToolchainJobStatus(value: unknown): boolean {
  return value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed';
}

function isToolchainProgressPercent(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= 100;
}

function isToolchainJobResult(value: unknown): value is typeof TOOLCHAIN_JOB_RESULTS[number] {
  return typeof value === 'string' && TOOLCHAIN_JOB_RESULTS.includes(value as typeof TOOLCHAIN_JOB_RESULTS[number]);
}

function isToolchainError(value: unknown): value is typeof TOOLCHAIN_ERROR_MESSAGES[number] {
  return typeof value === 'string' && TOOLCHAIN_ERROR_MESSAGES.includes(value as typeof TOOLCHAIN_ERROR_MESSAGES[number]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isNonEmptyText(entry));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}


async function executeLegacyTaskCapability(
  body: Record<string, unknown>,
  deps: CapabilityRouteContext,
): Promise<{ status: number; body: unknown }> {
  if (body.operationId !== 'tools.invoke') {
    return typeof body.operationId === 'string' && body.operationId.length > 0
      ? { status: 400, body: { success: false, error: `Capability operation not supported: ${body.operationId}` } }
      : { status: 400, body: { success: false, error: 'Capability operationId is required' } };
  }
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])) {
    return { status: 400, body: TASK_MANAGER_INVALID };
  }

  const scope = body.scope;
  if (!isRecord(scope)
    || !hasExactKeys(scope, ['kind', 'identity'])
    || scope.kind !== 'session'
    || !isTaskIdentity(scope.identity)) {
    return { status: 400, body: TASK_MANAGER_INVALID };
  }
  const identity = scope.identity;

  const target = body.target;
  if (!isRecord(target)
    || !hasExactKeys(target, ['kind', 'toolName', 'identity'])
    || target.kind !== 'tool') {
    return { status: 400, body: { success: false, error: 'Capability target kind must be tool' } };
  }
  const input = body.input;
  if (!isRecord(input)) {
    return { status: 400, body: { success: false, error: 'Capability input method is required' } };
  }
  const method = input.method;
  if (typeof method !== 'string' || method.trim().length === 0) {
    return { status: 400, body: { success: false, error: 'Capability input method is required' } };
  }
  if (target.toolName !== method) {
    return { status: 400, body: { success: false, error: 'Capability target toolName must match input method' } };
  }
  if (!isTaskIdentity(target.identity) || !sameTaskIdentity(target.identity, identity)) {
    return { status: 400, body: { success: false, error: 'Capability target identity must match request scope' } };
  }
  if (!isTaskIdentity(input.sessionIdentity) || !sameTaskIdentity(target.identity, input.sessionIdentity)) {
    return { status: 400, body: { success: false, error: 'Capability target identity must match input sessionIdentity' } };
  }
  if (!hasExactKeys(input, ['sessionIdentity', 'method', 'params'])) {
    return { status: 400, body: TASK_MANAGER_INVALID };
  }
  if (!isLegacyTaskMethod(method)) {
    return { status: 400, body: { success: false, error: `Task tool method not supported: ${method}` } };
  }
  if (!isRecord(input.params)) {
    return { status: 400, body: { success: false, error: 'sessionKey is required' } };
  }

  const params = input.params;
  const allowedParams: Record<LegacyTaskMethod, readonly string[]> = {
    TaskList: ['sessionKey', 'teamKey'],
    TaskGet: ['sessionKey', 'teamKey', 'taskId'],
    TaskCreate: ['sessionKey', 'teamKey', 'subject', 'description', 'activeForm', 'metadata', 'owner'],
    TaskUpdate: ['sessionKey', 'teamKey', 'taskId', 'status', 'subject', 'description', 'activeForm', 'metadata', 'owner', 'addBlockedBy', 'addBlocks'],
    TodoGet: ['sessionKey'],
    TodoWrite: ['sessionKey', 'oldTodos', 'newTodos'],
  };
  if (!hasOnlyKeys(params, allowedParams[method])) {
    return { status: 400, body: TASK_MANAGER_INVALID };
  }
  if (!isNonEmptyText(params.sessionKey)) {
    return { status: 400, body: { success: false, error: 'sessionKey is required' } };
  }
  if (params.sessionKey !== identity.sessionKey) {
    return { status: 400, body: TASK_MANAGER_INVALID };
  }
  if ((method === 'TaskCreate' || method === 'TaskUpdate')
    && Object.hasOwn(params, 'metadata')
    && !isRecord(params.metadata)) {
    return { status: 400, body: TASK_MANAGER_INVALID };
  }
  if (['TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate'].includes(method)
    && params.teamKey !== undefined
    && !isNonEmptyText(params.teamKey)) {
    return { status: 400, body: TASK_MANAGER_INVALID };
  }
  if ((method === 'TaskGet' || method === 'TaskUpdate') && !isNonEmptyText(params.taskId)) {
    return { status: 400, body: { success: false, error: 'taskId is required' } };
  }
  if (method === 'TaskCreate' && !isNonEmptyText(params.subject)) {
    return { status: 400, body: { success: false, error: 'subject is required' } };
  }
  if (method === 'TodoWrite') {
    if (!Array.isArray(params.oldTodos)) {
      return { status: 400, body: { success: false, error: 'oldTodos is required' } };
    }
    if (!Array.isArray(params.newTodos)) {
      return { status: 400, body: { success: false, error: 'newTodos is required' } };
    }
  }

  let operation: TaskManagementOperation;
  let response: TaskManagerTransportResponse;
  switch (method) {
    case 'TaskList': {
      operation = 'tasks.list';
      const request = buildTaskManagementRequest(operation, identity, {
        sessionIdentity: identity,
        ...(params.teamKey === undefined ? {} : { teamKey: params.teamKey }),
      });
      if (!isTaskRequest(request, operation)) return { status: 400, body: TASK_MANAGER_INVALID };
      try {
        response = await deps.taskManagerTransport.list(request);
      } catch {
        return { status: 503, body: TASK_MANAGER_UNAVAILABLE };
      }
      break;
    }
    case 'TaskGet': {
      operation = 'tasks.get';
      const request = buildTaskManagementRequest(operation, identity, {
        sessionIdentity: identity,
        ...(params.teamKey === undefined ? {} : { teamKey: params.teamKey }),
        taskId: params.taskId,
      });
      if (!isTaskRequest(request, operation)) return { status: 400, body: TASK_MANAGER_INVALID };
      try {
        response = await deps.taskManagerTransport.get(request);
      } catch {
        return { status: 503, body: TASK_MANAGER_UNAVAILABLE };
      }
      break;
    }
    case 'TaskCreate': {
      operation = 'tasks.create';
      const request = buildTaskManagementRequest(operation, identity, {
        sessionIdentity: identity,
        ...(params.teamKey === undefined ? {} : { teamKey: params.teamKey }),
        subject: params.subject,
        description: params.description,
        ...(params.activeForm === undefined ? {} : { activeForm: params.activeForm }),
        ...(Object.hasOwn(params, 'metadata') ? { metadata: params.metadata } : {}),
        ...(params.owner === undefined ? {} : { owner: params.owner }),
      });
      if (!isTaskRequest(request, operation)) return { status: 400, body: TASK_MANAGER_INVALID };
      try {
        response = await deps.taskManagerTransport.create(request);
      } catch {
        return { status: 503, body: TASK_MANAGER_UNAVAILABLE };
      }
      break;
    }
    case 'TaskUpdate': {
      operation = 'tasks.update';
      const request = buildTaskManagementRequest(operation, identity, {
        sessionIdentity: identity,
        ...(params.teamKey === undefined ? {} : { teamKey: params.teamKey }),
        taskId: params.taskId,
        ...(params.status === undefined ? {} : { status: params.status }),
        ...(params.subject === undefined ? {} : { subject: params.subject }),
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.activeForm === undefined ? {} : { activeForm: params.activeForm }),
        ...(Object.hasOwn(params, 'metadata') ? { metadata: params.metadata } : {}),
        ...(params.owner === undefined ? {} : { owner: params.owner }),
        ...(params.addBlockedBy === undefined ? {} : { addBlockedBy: params.addBlockedBy }),
        ...(params.addBlocks === undefined ? {} : { addBlocks: params.addBlocks }),
      });
      if (!isTaskRequest(request, operation)) return { status: 400, body: TASK_MANAGER_INVALID };
      try {
        response = await deps.taskManagerTransport.update(request);
      } catch {
        return { status: 503, body: TASK_MANAGER_UNAVAILABLE };
      }
      break;
    }
    case 'TodoGet': {
      operation = 'todos.get';
      const request = buildTaskManagementRequest(operation, identity, { sessionIdentity: identity });
      if (!isTaskRequest(request, operation)) return { status: 400, body: TASK_MANAGER_INVALID };
      try {
        response = await deps.taskManagerTransport.getTodos(request);
      } catch {
        return { status: 503, body: TASK_MANAGER_UNAVAILABLE };
      }
      break;
    }
    case 'TodoWrite': {
      operation = 'todos.write';
      const request = buildTaskManagementRequest(operation, identity, {
        sessionIdentity: identity,
        oldTodos: params.oldTodos,
        newTodos: params.newTodos,
      });
      if (!isTaskRequest(request, operation)) return { status: 400, body: TASK_MANAGER_INVALID };
      try {
        response = await deps.taskManagerTransport.writeTodos(request);
      } catch {
        return { status: 503, body: TASK_MANAGER_UNAVAILABLE };
      }
      break;
    }
  }

  return projectLegacyTaskResponse(method, operation, params, response);
}

function buildTaskManagementRequest(
  operation: TaskManagementOperation,
  identity: TaskIdentity,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: 'task.management',
    operationId: operation,
    scope: { kind: 'session', identity },
    target: { kind: 'task-manager', identity },
    input,
  };
}

function projectLegacyTaskResponse(
  method: LegacyTaskMethod,
  operation: TaskManagementOperation,
  params: Record<string, unknown>,
  response: TaskManagerTransportResponse,
): { status: number; body: unknown } {
  if (!isTaskManagerResponse(response.body, operation)) {
    return { status: 503, body: TASK_MANAGER_UNAVAILABLE };
  }
  const body = response.body;
  if (isRecord(body) && hasExactKeys(body, ['success', 'error'])) {
    return body.error === TASK_MANAGER_REJECTED.error
      ? { status: 409, body: TASK_MANAGER_REJECTED }
      : { status: 503, body: TASK_MANAGER_UNAVAILABLE };
  }
  if (response.status !== 200) {
    return { status: 503, body: TASK_MANAGER_UNAVAILABLE };
  }
  if (isRecord(body) && body.outcome === 'rejected') {
    return { status: 409, body: TASK_MANAGER_REJECTED };
  }
  if (isRecord(body) && body.outcome === 'unknown') {
    return { status: 503, body: TASK_MANAGER_UNAVAILABLE };
  }

  switch (method) {
    case 'TaskList':
      return { status: 200, body: { tasks: (body as Record<string, unknown>).tasks, todos: (body as Record<string, unknown>).todos } };
    case 'TaskGet':
      return { status: 200, body: { task: (body as Record<string, unknown>).task } };
    case 'TaskCreate': {
      const snapshot = (body as Record<string, unknown>).snapshot as Record<string, unknown>;
      return { status: 200, body: { task: (body as Record<string, unknown>).task, todos: snapshot.todos } };
    }
    case 'TaskUpdate': {
      const snapshot = (body as Record<string, unknown>).snapshot as Record<string, unknown>;
      if (params.status === 'deleted') {
        return { status: 200, body: { taskId: params.taskId, deleted: true, todos: snapshot.todos } };
      }
      const task = snapshot.tasks instanceof Array
        ? snapshot.tasks.find((candidate) => isRecord(candidate) && candidate.id === params.taskId)
        : undefined;
      return task
        ? { status: 200, body: { task } }
        : { status: 503, body: TASK_MANAGER_UNAVAILABLE };
    }
    case 'TodoGet': {
      const todoSnapshot = body as Record<string, unknown>;
      return { status: 200, body: { todos: todoSnapshot.todos, updatedAt: todoSnapshot.updatedAt } };
    }
    case 'TodoWrite': {
      const todoSnapshot = (body as Record<string, unknown>).snapshot as Record<string, unknown>;
      return { status: 200, body: { todos: todoSnapshot.todos, updatedAt: todoSnapshot.updatedAt } };
    }
  }
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
  outcome: RuntimeHostControlOutcome,
): { success: true; result: {
  outcome: 'accepted' | 'skipped' | 'outcome-unknown';
  reason?: 'already-running' | 'not-due' | 'invalid-spec';
} } | null {
  if (!isRecord(outcome)
    || !hasExactKeys(outcome, ['kind', 'result'])
    || outcome.kind !== 'succeeded'
    || !isRecord(outcome.result)
    || !hasExactKeys(outcome.result, ['result'])
    || !isRecord(outcome.result.result)
    || !hasOnlyKeys(outcome.result.result, ['outcome', 'reason'])
    || !Object.hasOwn(outcome.result.result, 'outcome')
    || (outcome.result.result.outcome !== 'accepted'
      && outcome.result.result.outcome !== 'skipped'
      && outcome.result.result.outcome !== 'outcome-unknown')
    || (outcome.result.result.reason !== undefined
      && !isCronTriggerSkipReason(outcome.result.result.reason))) {
    return null;
  }
  if (outcome.result.result.outcome !== 'skipped' && outcome.result.result.reason !== undefined) {
    return null;
  }
  return {
    success: true,
    result: {
      outcome: outcome.result.result.outcome,
      ...(outcome.result.result.reason === undefined ? {} : { reason: outcome.result.result.reason }),
    },
  };
}

function isCronTriggerSkipReason(value: unknown): value is 'already-running' | 'not-due' | 'invalid-spec' {
  return value === 'already-running' || value === 'not-due' || value === 'invalid-spec';
}

type CapabilityDirectory = Readonly<{
  capabilities: CapabilityDescriptor[];
}>;

const LICENSE_RUNTIME_DESCRIPTOR: CapabilityDescriptor = {
  id: 'license.runtime',
  kind: 'license-runtime',
  scopeKind: 'app',
  scope: { kind: 'app' },
  targetKinds: ['license'],
  supportLevel: 'native',
  availability: 'available',
  operations: [
    { id: 'license.validate', title: 'Validate license', targetKind: 'license', targetRequired: true },
    { id: 'license.revalidate', title: 'Revalidate stored license', targetKind: 'license', targetRequired: true },
    { id: 'license.clear', title: 'Clear stored license', targetKind: 'license', targetRequired: true },
  ],
  policyScope: 'license.runtime',
  ownerModuleId: 'license',
  routeOwnerId: 'license',
};

function isCapabilityDescribeRequest(
  value: unknown,
): value is { id: string; scope: RuntimeScope } {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'scope'])
    && isCapabilityText(value.id)
    && validateRuntimeScope(value.scope) === null;
}

function decodeCapabilityDirectory(outcome: RuntimeHostControlOutcome): CapabilityDirectory | null {
  if (!isRecord(outcome)
    || !hasExactKeys(outcome, ['kind', 'result'])
    || outcome.kind !== 'succeeded'
    || !isRecord(outcome.result)
    || !hasExactKeys(outcome.result, ['capabilities'])
    || !Array.isArray(outcome.result.capabilities)) {
    return null;
  }
  const capabilities: CapabilityDescriptor[] = [];
  const ids = new Set<string>();
  for (const value of outcome.result.capabilities) {
    const capability = decodeCapabilityDescriptor(value);
    if (!capability || ids.has(capability.id)) return null;
    ids.add(capability.id);
    capabilities.push(capability);
  }
  return { capabilities };
}

function projectCapabilityDirectory(directory: CapabilityDirectory | null): CapabilityDirectory | null {
  if (!directory) return null;
  return {
    capabilities: [
      ...directory.capabilities.filter(({ id }) => id !== LICENSE_RUNTIME_DESCRIPTOR.id),
      LICENSE_RUNTIME_DESCRIPTOR,
    ],
  };
}

function decodeCapabilityDescribe(
  outcome: RuntimeHostControlOutcome,
  requestedId: string,
  requestedScope: RuntimeScope,
): CapabilityDescriptor | null {
  if (!isRecord(outcome)
    || !hasExactKeys(outcome, ['kind', 'result'])
    || outcome.kind !== 'succeeded'
    || !isRecord(outcome.result)
    || !hasExactKeys(outcome.result, ['capability'])) {
    return null;
  }
  const capability = decodeCapabilityDescriptor(outcome.result.capability);
  return capability
    && capability.id === requestedId
    && sameRuntimeScope(capability.scope, requestedScope)
    ? capability
    : null;
}

function isInvalidCapabilityRejection(outcome: RuntimeHostControlOutcome): boolean {
  return isRecord(outcome)
    && hasExactKeys(outcome, ['kind', 'error'])
    && outcome.kind === 'rejected'
    && isRecord(outcome.error)
    && hasExactKeys(outcome.error, ['code', 'message'])
    && outcome.error.code === 'INVALID_INPUT'
    && typeof outcome.error.message === 'string';
}

function decodeCapabilityDescriptor(value: unknown): CapabilityDescriptor | null {
  const allowed = [
    'id',
    'kind',
    'scopeKind',
    'scope',
    'targetKinds',
    'runtimeAdapterId',
    'runtimeInstanceId',
    'protocolId',
    'connectorId',
    'endpointId',
    'targetAgentIds',
    'supportLevel',
    'availability',
    'operations',
    'policyScope',
    'ownerModuleId',
    'routeOwnerId',
  ] as const;
  const required = [
    'id',
    'kind',
    'scopeKind',
    'scope',
    'targetKinds',
    'supportLevel',
    'availability',
    'operations',
    'policyScope',
    'ownerModuleId',
    'routeOwnerId',
  ] as const;
  if (!isRecord(value)
    || !hasOnlyKeys(value, allowed)
    || !required.every((key) => Object.hasOwn(value, key))
    || !isCapabilityText(value.id)
    || !isCapabilityText(value.kind)
    || !isRuntimeScopeKind(value.scopeKind)
    || validateRuntimeScope(value.scope) !== null
    || value.scope.kind !== value.scopeKind
    || !Array.isArray(value.targetKinds)
    || !value.targetKinds.every(isCapabilityText)
    || !isCapabilitySupportLevel(value.supportLevel)
    || !isCapabilityAvailability(value.availability)
    || !Array.isArray(value.operations)
    || !value.operations.every(isCapabilityOperation)
    || !isCapabilityText(value.policyScope)
    || !isCapabilityText(value.ownerModuleId)
    || !isCapabilityText(value.routeOwnerId)
    || !optionalCapabilityText(value.runtimeAdapterId)
    || !optionalCapabilityText(value.runtimeInstanceId)
    || !optionalCapabilityText(value.protocolId)
    || !optionalCapabilityText(value.connectorId)
    || !optionalCapabilityText(value.endpointId)
    || !optionalCapabilityTextArray(value.targetAgentIds)) {
    return null;
  }
  return value as CapabilityDescriptor;
}

function isCapabilityOperation(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['id', 'title', 'targetKind', 'targetRequired'])
    && Object.hasOwn(value, 'id')
    && Object.hasOwn(value, 'title')
    && Object.hasOwn(value, 'targetKind')
    && isCapabilityText(value.id)
    && isCapabilityText(value.title)
    && isCapabilityText(value.targetKind)
    && (value.targetRequired === undefined || typeof value.targetRequired === 'boolean');
}

function sameRuntimeScope(left: RuntimeScope, right: RuntimeScope): boolean {
  try {
    return buildCapabilityScopeKey(left) === buildCapabilityScopeKey(right);
  } catch {
    return false;
  }
}

function isRuntimeScopeKind(value: unknown): value is RuntimeScope['kind'] {
  return value === 'app'
    || value === 'runtime-instance'
    || value === 'agent'
    || value === 'session'
    || value === 'workspace'
    || value === 'team-run'
    || value === 'provider-routing';
}

function isCapabilitySupportLevel(value: unknown): boolean {
  return value === 'native'
    || value === 'projected'
    || value === 'emulated'
    || value === 'readonly'
    || value === 'unsupported';
}

function isCapabilityAvailability(value: unknown): boolean {
  return value === 'available' || value === 'unavailable';
}

function isCapabilityText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !Array.from(value).some((character) => /\p{Cc}/u.test(character));
}

function optionalCapabilityText(value: unknown): value is string | undefined {
  return value === undefined || isCapabilityText(value);
}

function optionalCapabilityTextArray(value: unknown): value is string[] | undefined {
  return value === undefined || Array.isArray(value) && value.every(isCapabilityText);
}

function isLegacyTaskMethod(value: unknown): value is LegacyTaskMethod {
  return typeof value === 'string' && LEGACY_TASK_METHODS.includes(value as LegacyTaskMethod);
}

async function executeLicenseCapability(
  body: Record<string, unknown>,
  service: HostApiContext['licenseService'],
): Promise<{ status: number; body: unknown }> {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'license.runtime'
    || !isAppScope(body.scope)
    || !isLicenseTarget(body.target)
    || !isRecord(body.input)) {
    return { status: 404, body: CAPABILITY_NOT_AVAILABLE };
  }

  if (body.operationId === 'license.validate') {
    if (!hasExactKeys(body.input, ['key']) || typeof body.input.key !== 'string' || body.input.key.length === 0) {
      return { status: 400, body: CAPABILITY_REQUEST_FAILED };
    }
    try {
      const result = await service.validate(body.input.key);
      const publicResult = projectLicenseValidationResult(result);
      return publicResult
        ? { status: 200, body: publicResult }
        : { status: 503, body: { success: false, error: 'License service is unavailable' } };
    } catch {
      return { status: 503, body: { success: false, error: 'License service is unavailable' } };
    }
  }

  if (body.operationId === 'license.revalidate') {
    if (!hasExactKeys(body.input, [])) return { status: 400, body: CAPABILITY_REQUEST_FAILED };
    try {
      const result = await service.revalidate();
      const publicResult = projectLicenseValidationResult(result);
      return publicResult
        ? { status: 200, body: publicResult }
        : { status: 503, body: { success: false, error: 'License service is unavailable' } };
    } catch {
      return { status: 503, body: { success: false, error: 'License service is unavailable' } };
    }
  }

  if (body.operationId === 'license.clear') {
    if (!hasExactKeys(body.input, [])) return { status: 400, body: CAPABILITY_REQUEST_FAILED };
    try {
      const result = await service.clear();
      return result && isRecord(result) && hasExactKeys(result, ['success']) && result.success === true
        ? { status: 200, body: { success: true } }
        : { status: 503, body: { success: false, error: 'License service is unavailable' } };
    } catch {
      return { status: 503, body: { success: false, error: 'License service is unavailable' } };
    }
  }

  return { status: 404, body: CAPABILITY_NOT_AVAILABLE };
}

function projectLicenseValidationResult(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['valid', 'code', 'masked', 'last4', 'mode', 'source', 'expiresAt', 'refreshAfterSec', 'offlineGraceUntilMs'])
    || typeof value.valid !== 'boolean'
    || !isLicenseValidationCode(value.code)
    || (value.mode !== undefined && !isLicenseValidationMode(value.mode))
    || (value.masked !== undefined && value.masked !== null && typeof value.masked !== 'string')
    || (value.last4 !== undefined && value.last4 !== null && typeof value.last4 !== 'string')
    || (value.source !== undefined && value.source !== 'server' && value.source !== 'cache' && value.source !== 'local')
    || (value.expiresAt !== undefined && value.expiresAt !== null && typeof value.expiresAt !== 'string')
    || (value.refreshAfterSec !== undefined && !isNonNegativeSafeInteger(value.refreshAfterSec))
    || (value.offlineGraceUntilMs !== undefined && !isNonNegativeSafeInteger(value.offlineGraceUntilMs))) {
    return null;
  }
  return {
    valid: value.valid,
    code: value.code,
    ...(value.masked === undefined ? {} : { masked: value.masked }),
    ...(value.last4 === undefined ? {} : { last4: value.last4 }),
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    ...(value.refreshAfterSec === undefined ? {} : { refreshAfterSec: value.refreshAfterSec }),
    ...(value.offlineGraceUntilMs === undefined ? {} : { offlineGraceUntilMs: value.offlineGraceUntilMs }),
  };
}

function isLicenseValidationCode(value: unknown): boolean {
  return value === 'valid' || value === 'empty' || value === 'format_invalid'
    || value === 'service_unconfigured' || value === 'network_error' || value === 'server_rejected'
    || value === 'cache_grace_valid' || value === 'expired' || value === 'device_mismatch'
    || value === 'not_allowed' || value === 'checksum_invalid';
}

function isLicenseValidationMode(value: unknown): boolean {
  return value === 'online' || value === 'cache' || value === 'allowlist'
    || value === 'checksum' || value === 'none';
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

function isTaskRequest(value: Record<string, unknown>, operation: TaskOperation): boolean {
  const management = operation !== 'tasks.output' && operation !== 'tasks.stop';
  if (value.id !== (management ? 'task.management' : 'task.control')
    || value.operationId !== operation
    || !isRecord(value.scope)
    || !hasExactKeys(value.scope, ['kind', 'identity'])
    || value.scope.kind !== 'session'
    || !isTaskIdentity(value.scope.identity)
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind', 'identity'])
    || value.target.kind !== (management ? 'task-manager' : 'task')
    || !isTaskIdentity(value.target.identity)
    || !sameTaskIdentity(value.scope.identity, value.target.identity)
    || !isRecord(value.input)
    || !isTaskInput(value.input, operation)
    || !isTaskIdentity(value.input.sessionIdentity)) {
    return false;
  }
  return sameTaskIdentity(value.scope.identity, value.input.sessionIdentity);
}

function isTaskInput(value: Record<string, unknown>, operation: TaskOperation): boolean {
  const allowed: Record<TaskOperation, readonly string[]> = {
    'tasks.list': ['sessionIdentity', 'teamKey'],
    'tasks.get': ['sessionIdentity', 'teamKey', 'taskId'],
    'tasks.create': ['sessionIdentity', 'teamKey', 'subject', 'description', 'activeForm', 'metadata', 'owner'],
    'tasks.update': ['sessionIdentity', 'teamKey', 'taskId', 'status', 'subject', 'description', 'activeForm', 'metadata', 'owner', 'addBlockedBy', 'addBlocks'],
    'todos.get': ['sessionIdentity'],
    'todos.write': ['sessionIdentity', 'oldTodos', 'newTodos'],
    'tasks.output': ['sessionIdentity', 'taskId'],
    'tasks.stop': ['sessionIdentity', 'taskId'],
  };
  if (!Object.keys(value).every((key) => allowed[operation].includes(key))) return false;
  if (value.teamKey !== undefined && !isNonEmptyText(value.teamKey)) return false;
  if (['tasks.get', 'tasks.update', 'tasks.output', 'tasks.stop'].includes(operation)
    && !isNonEmptyText(value.taskId)) return false;
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
  if (operation === 'tasks.output') {
    return hasExactKeys(value, ['output']) && (value.output === 'available' || value.output === 'not_found');
  }
  if (operation === 'tasks.stop') {
    return (hasExactKeys(value, ['found', 'cancelled'])
      && typeof value.found === 'boolean'
      && typeof value.cancelled === 'boolean')
      || isClosedTaskMutation(value);
  }
  if (operation === 'todos.write') {
    return (hasExactKeys(value, ['outcome', 'snapshot'])
      && value.outcome === 'applied'
      && isTodoSnapshot(value.snapshot))
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

function isTodoSnapshot(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['todos', 'updatedAt'])
    && Array.isArray(value.todos)
    && value.todos.every(isTodo)
    && isNonNegativeSafeInteger(value.updatedAt);
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

function isAppScope(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'app';
}

function isLicenseTarget(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'subject'])
    && value.kind === 'license'
    && value.subject === 'key';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
