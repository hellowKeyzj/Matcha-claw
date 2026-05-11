import type {
  AssembleRequest,
  HealthStatus,
  RegistryQuery,
  ReconcileReport,
  RunId,
  ToolDefinition,
  ToolExecRequest,
  ToolExecResult,
  ToolId,
  ToolSource,
} from '../../shared/platform-runtime-contracts';

export interface RuntimeHostPlatformFacade {
  runtimeHealth(): Promise<HealthStatus>;
  installNativeTool(source: ToolSource): Promise<ToolId>;
  reconcileNativeTools(): Promise<ReconcileReport>;
  startRun(req: AssembleRequest, eventTx?: unknown): Promise<RunId>;
  abortRun(runId: RunId): Promise<void>;
  listEffectiveTools(query?: RegistryQuery): Promise<ToolDefinition[]>;
  upsertPlatformTools(tools: ToolDefinition[]): Promise<void>;
  setToolEnabled(toolId: ToolId, enabled: boolean): Promise<void>;
  executePlatformTool(req: ToolExecRequest): Promise<ToolExecResult>;
}
