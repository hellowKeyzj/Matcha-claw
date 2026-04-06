import type {
  AssembleRequest,
  RegistryQuery,
  ToolDefinition,
  ToolExecRequest,
} from '../../shared/platform-runtime-contracts';
import type { RuntimeHostPlatformFacade } from '../../api/platform/runtime-root';

interface PlatformServiceDeps {
  readonly platformRuntime: RuntimeHostPlatformFacade;
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
      return {
        status: 400,
        data: { success: false, error: 'runId is required' },
      };
    }
    await this.deps.platformRuntime.abortRun(runId);
    return {
      status: 200,
      data: { success: true },
    };
  }

  async installNativeTool(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    if (!isRecord(body.source)) {
      return {
        status: 400,
        data: { success: false, error: 'source is required' },
      };
    }
    return {
      status: 200,
      data: {
        success: true,
        toolId: await this.deps.platformRuntime.installNativeTool(body.source as never),
      },
    };
  }

  async reconcileTools() {
    return {
      success: true,
      report: await this.deps.platformRuntime.reconcileNativeTools(),
    };
  }

  async listTools(routeUrl: URL) {
    const includeDisabled = routeUrl.searchParams.get('includeDisabled') === 'true';
    const refresh = routeUrl.searchParams.get('refresh') !== 'false';
    if (refresh) {
      try {
        const health = await this.deps.platformRuntime.runtimeHealth();
        if (health.status === 'running') {
          await this.deps.platformRuntime.reconcileNativeTools();
        }
      } catch {
        // 保持返回当前快照
      }
    }
    return {
      success: true,
      tools: await this.deps.platformRuntime.listEffectiveTools({ includeDisabled }),
      refreshed: refresh,
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
      return {
        status: 400,
        data: { success: false, error: 'toolId is required' },
      };
    }
    await this.deps.platformRuntime.setToolEnabled(toolId, body.enabled === true);
    return {
      status: 200,
      data: { success: true },
    };
  }

  async executeTool(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const req = isRecord(body.req) ? body.req as ToolExecRequest : body as ToolExecRequest;
    return await this.deps.platformRuntime.executePlatformTool(req);
  }
}
