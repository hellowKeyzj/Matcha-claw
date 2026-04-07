import {
  ContextAssembler,
  GatewayPluginStateLedger,
  LocalPluginStateLedger,
  PolicyEngine,
  RunSessionService,
  RuntimeManagerService,
  ToolCatalogService,
  ToolReconciler,
  ToolRegistryStore,
  type AssembleRequest,
  type HealthStatus,
  type RegistryQuery,
  type ReconcileReport,
  type RunId,
  type ToolDefinition,
  type ToolExecRequest,
  type ToolExecResult,
  type ToolId,
  type ToolSource,
} from '../../application/platform-runtime';
import type { OpenClawBridge } from '../../openclaw-bridge';
import { InMemoryAuditSink } from './audit-sink';
import { LocalEventBus } from './local-event-bus';
import { OpenClawRuntimeDriver } from './openclaw-runtime-driver';
import { PlatformToolExecutor } from './tool-executor';

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

export interface RuntimeHostPlatformRoot {
  readonly facade: RuntimeHostPlatformFacade;
  readonly toolRegistry: ToolRegistryStore;
  readonly runtimeManager: RuntimeManagerService;
  readonly runSessionService: RunSessionService;
  readonly toolCatalogService: ToolCatalogService;
  readonly toolExecutor: PlatformToolExecutor;
}

export function createRuntimeHostPlatformRoot(
  openclawBridge: Pick<
    OpenClawBridge,
    | 'isGatewayRunning'
    | 'platformInstallTool'
    | 'platformUninstallTool'
    | 'platformEnableTool'
    | 'platformDisableTool'
    | 'platformListToolsCatalog'
    | 'platformStartRun'
    | 'platformAbortRun'
  >,
): RuntimeHostPlatformRoot {
  const runtimeDriver = new OpenClawRuntimeDriver(openclawBridge);
  const toolRegistry = new ToolRegistryStore();
  const gatewayLedger = new GatewayPluginStateLedger();
  const localLedger = new LocalPluginStateLedger();
  const policyEngine = new PolicyEngine();
  const auditSink = new InMemoryAuditSink();
  const eventBus = new LocalEventBus();
  const contextAssembler = new ContextAssembler(toolRegistry, policyEngine);
  const toolExecutor = new PlatformToolExecutor();
  const reconciler = new ToolReconciler(gatewayLedger, localLedger, toolRegistry, auditSink);
  const runtimeManager = new RuntimeManagerService(
    runtimeDriver,
    toolRegistry,
    auditSink,
    reconciler,
  );
  const runSessionService = new RunSessionService(
    contextAssembler,
    runtimeDriver,
    eventBus,
    auditSink,
  );
  const toolCatalogService = new ToolCatalogService(toolRegistry, auditSink);

  const facade: RuntimeHostPlatformFacade = {
    async runtimeHealth() {
      return await runtimeManager.runtimeHealth();
    },

    async installNativeTool(source) {
      const toolId = await runtimeDriver.installTool(source);
      const installed = await runtimeDriver.listInstalledTools();
      gatewayLedger.setAll(installed);
      await toolRegistry.upsertNative(installed);
      await auditSink.append({
        type: 'runtime.install_native_tool',
        ts: Date.now(),
        payload: { toolId, source: source.spec, kind: source.kind },
      });
      return toolId;
    },

    async reconcileNativeTools() {
      const upstream = await runtimeDriver.listInstalledTools();
      gatewayLedger.setAll(upstream);
      await toolRegistry.upsertNative(upstream);
      const report = await reconciler.reconcileTools();
      await auditSink.append({
        type: 'runtime.reconcile_native_tools',
        ts: Date.now(),
        payload: {
          discovered: report.discovered.length,
          missing: report.missing.length,
          conflicts: report.conflicts.length,
        },
      });
      return report;
    },

    async startRun(req, eventTx) {
      return await runSessionService.start(req, eventTx);
    },

    async abortRun(runId) {
      await runSessionService.abort(runId);
    },

    async listEffectiveTools(query: RegistryQuery = {}) {
      return await toolCatalogService.listEffective(query);
    },

    async upsertPlatformTools(tools) {
      await toolCatalogService.upsertPlatformTools(tools);
      localLedger.setAll(toolRegistry.snapshotPlatform());
    },

    async setToolEnabled(toolId, enabled) {
      if (enabled) {
        await runtimeDriver.enableTool(toolId);
      } else {
        await runtimeDriver.disableTool(toolId);
      }
      const upstream = await runtimeDriver.listInstalledTools();
      gatewayLedger.setAll(upstream);
      await toolRegistry.upsertNative(upstream);
      await auditSink.append({
        type: 'runtime.set_tool_enabled',
        ts: Date.now(),
        payload: { toolId, enabled },
      });
    },

    async executePlatformTool(req) {
      return await toolExecutor.executeTool(req);
    },
  };

  return {
    facade,
    toolRegistry,
    runtimeManager,
    runSessionService,
    toolCatalogService,
    toolExecutor,
  };
}
