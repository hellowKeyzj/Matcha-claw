import type {
  DriverConfig,
  HealthStatus,
  RunContext,
  RunId,
  ToolDefinition,
  ToolId,
  ToolSource,
} from './models';

export interface AgentRuntimeDriver {
  initialize(config: DriverConfig): Promise<void>;
  healthCheck(): Promise<HealthStatus>;

  installTool(source: ToolSource): Promise<ToolId>;
  uninstallTool(toolId: ToolId): Promise<void>;
  enableTool(toolId: ToolId): Promise<void>;
  disableTool(toolId: ToolId): Promise<void>;
  listInstalledTools(): Promise<ToolDefinition[]>;

  execute(context: RunContext, eventTx?: unknown): Promise<RunId>;
  abort(runId: RunId): Promise<void>;
}
