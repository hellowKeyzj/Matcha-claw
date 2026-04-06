import type {
  AgentRuntimeDriver,
  DriverConfig,
  HealthStatus,
  RunContext,
  RunId,
  ToolDefinition,
  ToolId,
  ToolSource,
} from '../../shared/platform-runtime-contracts';

export interface OpenClawRuntimeBridge {
  readonly isGatewayRunning: () => Promise<boolean>;
  readonly platformInstallTool: (source: ToolSource) => Promise<{ toolId?: string; id?: string }>;
  readonly platformUninstallTool: (toolId: ToolId) => Promise<void>;
  readonly platformEnableTool: (toolId: ToolId) => Promise<void>;
  readonly platformDisableTool: (toolId: ToolId) => Promise<void>;
  readonly platformListToolsCatalog: () => Promise<unknown>;
  readonly platformStartRun: (context: RunContext, eventTx?: unknown) => Promise<{ runId?: string; id?: string }>;
  readonly platformAbortRun: (runId: RunId) => Promise<void>;
}

function normalizeToolList(payload: unknown): ToolDefinition[] {
  const deduped = new Map<string, ToolDefinition>();
  const pushTool = (tool: ToolDefinition): void => {
    if (!tool.id || deduped.has(tool.id)) {
      return;
    }
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
    const pluginId = typeof record.pluginId === 'string' ? record.pluginId : defaults?.pluginId;
    const optional = typeof record.optional === 'boolean' ? record.optional : defaults?.optional;
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
      source: typeof record.source === 'string' ? record.source : defaults?.source ?? 'native',
      enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
      description: typeof record.description === 'string' ? record.description : undefined,
      version: typeof record.version === 'string' ? record.version : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  };

  if (Array.isArray(payload)) {
    payload.forEach((item) => {
      const tool = fromEntry(item);
      if (tool) {
        pushTool(tool);
      }
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
    const pushArray = (value: unknown, defaults?: { source?: string; pluginId?: string; optional?: boolean }) => {
      if (!Array.isArray(value)) {
        return;
      }
      value.forEach((item) => {
        const tool = fromEntry(item, defaults);
        if (tool) {
          pushTool(tool);
        }
      });
    };

    pushArray(maybe.tools);
    pushArray(maybe.plugins);
    pushArray(maybe.items);
    pushArray(maybe.data);

    if (Array.isArray(maybe.groups)) {
      maybe.groups.forEach((group) => {
        if (!group || typeof group !== 'object') {
          return;
        }
        const groupRecord = group as {
          source?: unknown;
          pluginId?: unknown;
          optional?: unknown;
          tools?: unknown;
        };
        pushArray(groupRecord.tools, {
          source: typeof groupRecord.source === 'string' ? groupRecord.source : 'core',
          pluginId: typeof groupRecord.pluginId === 'string' ? groupRecord.pluginId : undefined,
          optional: typeof groupRecord.optional === 'boolean' ? groupRecord.optional : undefined,
        });
      });
    }
  }

  return [...deduped.values()];
}

export class OpenClawRuntimeDriver implements AgentRuntimeDriver {
  constructor(private readonly bridge: OpenClawRuntimeBridge) {}

  async initialize(_config: DriverConfig): Promise<void> {}

  async healthCheck(): Promise<HealthStatus> {
    const running = await this.bridge.isGatewayRunning();
    return {
      status: running ? 'running' : 'stopped',
      detail: running ? undefined : 'gateway unavailable',
    };
  }

  async installTool(source: ToolSource): Promise<ToolId> {
    const payload = await this.bridge.platformInstallTool(source);
    return payload.toolId ?? payload.id ?? source.spec;
  }

  async uninstallTool(toolId: ToolId): Promise<void> {
    await this.bridge.platformUninstallTool(toolId);
  }

  async enableTool(toolId: ToolId): Promise<void> {
    await this.bridge.platformEnableTool(toolId);
  }

  async disableTool(toolId: ToolId): Promise<void> {
    await this.bridge.platformDisableTool(toolId);
  }

  async listInstalledTools(): Promise<ToolDefinition[]> {
    return normalizeToolList(await this.bridge.platformListToolsCatalog());
  }

  async execute(context: RunContext, eventTx?: unknown): Promise<RunId> {
    const payload = await this.bridge.platformStartRun(context, eventTx);
    return payload.runId ?? payload.id ?? `${context.sessionId}-${Date.now()}`;
  }

  async abort(runId: RunId): Promise<void> {
    await this.bridge.platformAbortRun(runId);
  }
}
