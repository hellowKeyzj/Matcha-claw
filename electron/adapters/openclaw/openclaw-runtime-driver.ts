import type {
  AgentRuntimeDriver,
  DriverConfig,
  HealthStatus,
  RunContext,
  RunId,
  ToolDefinition,
  ToolId,
  ToolSource,
} from '../../core/contracts';

export interface OpenClawGatewayPort {
  rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  getStatus(): { state: string; error?: string };
}

function normalizeToolList(payload: unknown): ToolDefinition[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is ToolDefinition => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string');
  }

  if (payload && typeof payload === 'object') {
    const maybe = payload as { tools?: unknown; plugins?: unknown };
    if (Array.isArray(maybe.tools)) {
      return normalizeToolList(maybe.tools);
    }
    if (Array.isArray(maybe.plugins)) {
      return normalizeToolList(maybe.plugins);
    }
  }

  return [];
}

export class OpenClawRuntimeDriver implements AgentRuntimeDriver {
  constructor(private readonly gateway: OpenClawGatewayPort) {}

  async initialize(_config: DriverConfig): Promise<void> {}

  async healthCheck(): Promise<HealthStatus> {
    const status = this.gateway.getStatus();
    return {
      status: status.state,
      detail: status.error,
    };
  }

  async installTool(source: ToolSource): Promise<ToolId> {
    const payload = await this.gateway.rpc<{ toolId?: string; id?: string }>('plugins.install', source);
    return payload.toolId ?? payload.id ?? source.spec;
  }

  async uninstallTool(toolId: ToolId): Promise<void> {
    await this.gateway.rpc('plugins.uninstall', { toolId });
  }

  async enableTool(toolId: ToolId): Promise<void> {
    await this.gateway.rpc('plugins.enable', { toolId });
  }

  async disableTool(toolId: ToolId): Promise<void> {
    await this.gateway.rpc('plugins.disable', { toolId });
  }

  async listInstalledTools(): Promise<ToolDefinition[]> {
    const payload = await this.gateway.rpc<unknown>('plugins.list');
    return normalizeToolList(payload);
  }

  async execute(context: RunContext, eventTx?: unknown): Promise<RunId> {
    const payload = await this.gateway.rpc<{ runId?: string; id?: string }>('agent.run', { context, eventTx });
    return payload.runId ?? payload.id ?? `${context.sessionId}-${Date.now()}`;
  }

  async abort(runId: RunId): Promise<void> {
    await this.gateway.rpc('agent.abort', { runId });
  }
}
