import type {
  AssembleRequest,
  ReconcileReport,
  RegistryQuery,
  RunContext,
  ToolDefinition,
  ToolExecRequest,
  ToolExecResult,
  ToolId,
  ToolSource,
  HealthStatus,
} from './models';

export interface ToolRegistryPort {
  upsertNative(tools: ToolDefinition[]): Promise<void>;
  upsertPlatform(tools: ToolDefinition[]): Promise<void>;
  setEnabled(toolId: ToolId, enabled: boolean): Promise<void>;
  listEffective(query: RegistryQuery): Promise<ToolDefinition[]>;
}

export interface ContextAssemblerPort {
  assemble(req: AssembleRequest): Promise<RunContext>;
}

export interface ToolExecutorPort {
  executeTool(req: ToolExecRequest): Promise<ToolExecResult>;
}

export interface RuntimeManagerPort {
  runtimeHealth(): Promise<HealthStatus>;
  installNativeTool(source: ToolSource): Promise<ToolId>;
  reconcileNativeTools(): Promise<ReconcileReport>;
}
