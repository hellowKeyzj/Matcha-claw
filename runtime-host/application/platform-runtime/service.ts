import type {
  AssembleRequest,
  RegistryQuery,
  ToolDefinition,
  ToolExecRequest,
  ToolSource,
} from '../../shared/platform-runtime-contracts';
import { accepted, badRequest, ok } from '../common/application-response';
import type { PlatformJobPort } from './platform-jobs';
import type { RuntimeHostPlatformFacade } from './platform-runtime-port';

interface PlatformServiceDeps {
  readonly platformRuntime: RuntimeHostPlatformFacade;
  readonly jobs: PlatformJobPort;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readQueryPayload(payload: unknown): RegistryQuery {
  const body = isRecord(payload) ? payload : {};
  const requestedToolIds = Array.isArray(body.requestedToolIds)
    ? body.requestedToolIds.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    includeDisabled: body.includeDisabled === true,
    ...(requestedToolIds && requestedToolIds.length > 0 ? { requestedToolIds } : {}),
  };
}

export class PlatformService {
  constructor(private readonly deps: PlatformServiceDeps) {}

  async runtimeHealth() {
    const health = await this.deps.platformRuntime.runtimeHealth();
    return {
      success: true,
      status: health.status,
      detail: health.detail,
      ok: health.status === 'running',
    };
  }

  async startRun(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const req = isRecord(body.req) ? body.req as AssembleRequest : body as AssembleRequest;
    const eventTx = 'eventTx' in body ? body.eventTx : undefined;
    return {
      success: true,
      runId: await this.deps.platformRuntime.startRun(req, eventTx),
    };
  }

  async abortRun(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const runId = typeof body.runId === 'string' ? body.runId : '';
    if (!runId) {
      return badRequest('runId is required');
    }
    await this.deps.platformRuntime.abortRun(runId);
    return ok({ success: true });
  }

  async installNativeTool(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    if (!isRecord(body.source)) {
      return badRequest('source is required');
    }
    return accepted(this.deps.jobs.submitInstallNativeTool(body.source as ToolSource));
  }

  reconcileTools() {
    return this.deps.jobs.submitReconcileTools();
  }

  async listTools(routeUrl: URL) {
    const includeDisabled = routeUrl.searchParams.get('includeDisabled') === 'true';
    return {
      success: true,
      tools: await this.deps.platformRuntime.listEffectiveTools({ includeDisabled }),
    };
  }

  async executeInstallNativeTool(source: ToolSource) {
    return {
      toolId: await this.deps.platformRuntime.installNativeTool(source),
    };
  }

  async executeReconcileTools() {
    return {
      report: await this.deps.platformRuntime.reconcileNativeTools(),
    };
  }

  async queryTools(payload: unknown) {
    return {
      success: true,
      tools: await this.deps.platformRuntime.listEffectiveTools(readQueryPayload(payload)),
    };
  }

  async upsertPlatformTools(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const tools = Array.isArray(body.tools)
      ? body.tools.filter((item): item is ToolDefinition => isRecord(item) && typeof item.id === 'string')
      : [];
    await this.deps.platformRuntime.upsertPlatformTools(tools);
    return { success: true };
  }

  async setToolEnabled(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const toolId = typeof body.toolId === 'string' ? body.toolId : '';
    if (!toolId) {
      return badRequest('toolId is required');
    }
    await this.deps.platformRuntime.setToolEnabled(toolId, body.enabled === true);
    return ok({ success: true });
  }

  async executeTool(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const req = isRecord(body.req) ? body.req as ToolExecRequest : body as ToolExecRequest;
    return await this.deps.platformRuntime.executePlatformTool(req);
  }
}
