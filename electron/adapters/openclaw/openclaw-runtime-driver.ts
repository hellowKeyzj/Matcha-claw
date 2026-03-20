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
  const deduped = new Map<string, ToolDefinition>();
  const pushTool = (tool: ToolDefinition): void => {
    if (!tool.id) return;
    if (deduped.has(tool.id)) return;
    deduped.set(tool.id, tool);
  };

  const fromEntry = (
    entry: unknown,
    defaults?: { source?: string; pluginId?: string; optional?: boolean },
  ): ToolDefinition | null => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const record = entry as {
      id?: unknown;
      toolId?: unknown;
      name?: unknown;
      label?: unknown;
      enabled?: unknown;
      description?: unknown;
      version?: unknown;
      source?: unknown;
      pluginId?: unknown;
      optional?: unknown;
    };
    const id = typeof record.id === 'string'
      ? record.id
      : typeof record.toolId === 'string'
        ? record.toolId
        : typeof record.name === 'string'
          ? record.name
          : typeof record.label === 'string'
            ? record.label
            : '';
    if (!id) {
      return null;
    }
    const pluginId = typeof record.pluginId === 'string'
      ? record.pluginId
      : defaults?.pluginId;
    const optional = typeof record.optional === 'boolean'
      ? record.optional
      : defaults?.optional;
    const metadata: Record<string, unknown> = {};
    if (pluginId) metadata.pluginId = pluginId;
    if (typeof optional === 'boolean') metadata.optional = optional;
    return {
      id,
      name: typeof record.name === 'string'
        ? record.name
        : typeof record.label === 'string'
          ? record.label
          : id,
      source: typeof record.source === 'string'
        ? record.source
        : defaults?.source ?? 'native',
      enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
      description: typeof record.description === 'string' ? record.description : undefined,
      version: typeof record.version === 'string' ? record.version : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  };

  if (Array.isArray(payload)) {
    payload.forEach((item) => {
      const tool = fromEntry(item);
      if (tool) pushTool(tool);
    });
    return [...deduped.values()];
  }

  if (payload && typeof payload === 'object') {
    const maybe = payload as {
      tools?: unknown;
      plugins?: unknown;
      items?: unknown;
      data?: unknown;
      groups?: unknown;
    };
    if (Array.isArray(maybe.tools)) {
      maybe.tools.forEach((item) => {
        const tool = fromEntry(item);
        if (tool) pushTool(tool);
      });
    }
    if (Array.isArray(maybe.plugins)) {
      maybe.plugins.forEach((item) => {
        const tool = fromEntry(item);
        if (tool) pushTool(tool);
      });
    }
    if (Array.isArray(maybe.items)) {
      maybe.items.forEach((item) => {
        const tool = fromEntry(item);
        if (tool) pushTool(tool);
      });
    }
    if (Array.isArray(maybe.data)) {
      maybe.data.forEach((item) => {
        const tool = fromEntry(item);
        if (tool) pushTool(tool);
      });
    }
    if (Array.isArray(maybe.groups)) {
      maybe.groups.forEach((group) => {
        if (!group || typeof group !== 'object') return;
        const groupRecord = group as {
          source?: unknown;
          pluginId?: unknown;
          optional?: unknown;
          tools?: unknown;
        };
        if (!Array.isArray(groupRecord.tools)) return;
        const defaults = {
          source: typeof groupRecord.source === 'string' ? groupRecord.source : 'core',
          pluginId: typeof groupRecord.pluginId === 'string' ? groupRecord.pluginId : undefined,
          optional: typeof groupRecord.optional === 'boolean' ? groupRecord.optional : undefined,
        };
        groupRecord.tools.forEach((item) => {
          const tool = fromEntry(item, defaults);
          if (tool) pushTool(tool);
        });
      });
    }
  }

  return [...deduped.values()];
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
    const payload = await this.gateway.rpc<unknown>('tools.catalog', { includePlugins: true });
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
