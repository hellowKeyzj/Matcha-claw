import type {
  AssembleRequest,
  HealthStatus,
  ReconcileReport,
  RegistryQuery,
  RunId,
  RuntimeManagerPort,
  ToolDefinition,
  ToolExecRequest,
  ToolExecResult,
  ToolId,
  ToolSource,
  ToolExecutorPort,
} from '../core/contracts';
import type { RunSessionService, ToolCatalogService } from '../core/application';
import type { LocalPluginStateLedger } from '../adapters/platform/ledger';
import type { ToolRegistryStore } from '../adapters/platform/tool-registry-store';

export interface PlatformRuntimeFacade {
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

export class PlatformIpcFacade implements PlatformRuntimeFacade {
  constructor(
    private readonly runtimeManager: RuntimeManagerPort,
    private readonly runSessionService: RunSessionService,
    private readonly toolCatalogService: ToolCatalogService,
    private readonly toolExecutor: ToolExecutorPort,
    private readonly localLedger: LocalPluginStateLedger,
    private readonly registryStore: ToolRegistryStore,
  ) {}

  async runtimeHealth(): Promise<HealthStatus> {
    return this.runtimeManager.runtimeHealth();
  }

  async installNativeTool(source: ToolSource): Promise<ToolId> {
    return this.runtimeManager.installNativeTool(source);
  }

  async reconcileNativeTools(): Promise<ReconcileReport> {
    return this.runtimeManager.reconcileNativeTools();
  }

  async startRun(req: AssembleRequest, eventTx?: unknown): Promise<RunId> {
    return this.runSessionService.start(req, eventTx);
  }

  async abortRun(runId: RunId): Promise<void> {
    await this.runSessionService.abort(runId);
  }

  async listEffectiveTools(query: RegistryQuery = {}): Promise<ToolDefinition[]> {
    return this.toolCatalogService.listEffective(query);
  }

  async upsertPlatformTools(tools: ToolDefinition[]): Promise<void> {
    await this.toolCatalogService.upsertPlatformTools(tools);
    this.localLedger.setAll(this.registryStore.snapshotPlatform());
  }

  async setToolEnabled(toolId: ToolId, enabled: boolean): Promise<void> {
    await this.toolCatalogService.setToolEnabled(toolId, enabled);
    this.localLedger.setAll(this.registryStore.snapshotPlatform());
  }

  async executePlatformTool(req: ToolExecRequest): Promise<ToolExecResult> {
    return this.toolExecutor.executeTool(req);
  }
}
