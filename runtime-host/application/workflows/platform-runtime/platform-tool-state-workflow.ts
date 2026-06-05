import type {
  AgentRuntimeDriver,
  AuditSinkPort,
  ReconcileReport,
  ToolDefinition,
  ToolId,
} from '../../../shared/platform-runtime-contracts';
import type { RuntimeClockPort } from '../../common/runtime-ports';
import type { GatewayPluginStateLedger } from '../../platform-runtime/state/gateway-plugin-state-ledger';
import type { LocalPluginStateLedger } from '../../platform-runtime/state/local-plugin-state-ledger';
import type { ToolRegistryStore } from '../../platform-runtime/state/tool-registry-store';
import type { ToolCatalogService } from '../../platform-runtime/tool-catalog-service';
import type { PlatformNativeToolWorkflow } from './platform-native-tool-workflow';

export interface PlatformToolStateWorkflowDeps {
  readonly runtimeDriver: AgentRuntimeDriver;
  readonly gatewayLedger: GatewayPluginStateLedger;
  readonly localLedger: LocalPluginStateLedger;
  readonly toolRegistry: ToolRegistryStore;
  readonly auditSink: AuditSinkPort;
  readonly nativeToolWorkflow: Pick<PlatformNativeToolWorkflow, 'installNativeTool' | 'reconcileNativeTools'>;
  readonly toolCatalogService: Pick<ToolCatalogService, 'upsertPlatformTools'>;
  readonly clock: RuntimeClockPort;
}

export class PlatformToolStateWorkflow {
  constructor(private readonly deps: PlatformToolStateWorkflowDeps) {}

  async installNativeTool(source: Parameters<PlatformNativeToolWorkflow['installNativeTool']>[0]): Promise<ToolId> {
    const toolId = await this.deps.nativeToolWorkflow.installNativeTool(source);
    await this.refreshGatewayLedgerFromRuntime();
    return toolId;
  }

  async reconcileNativeTools(): Promise<ReconcileReport> {
    const report = await this.deps.nativeToolWorkflow.reconcileNativeTools();
    await this.refreshGatewayLedgerFromRuntime();
    return report;
  }

  async upsertPlatformTools(tools: ToolDefinition[]): Promise<void> {
    await this.deps.toolCatalogService.upsertPlatformTools(tools);
    this.deps.localLedger.setAll(this.deps.toolRegistry.snapshotPlatform());
  }

  async setToolEnabled(toolId: ToolId, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.deps.runtimeDriver.enableTool(toolId);
    } else {
      await this.deps.runtimeDriver.disableTool(toolId);
    }
    const upstream = await this.deps.runtimeDriver.listInstalledTools();
    this.deps.gatewayLedger.setAll(upstream);
    await this.deps.toolRegistry.upsertNative(upstream);
    await this.deps.auditSink.append({
      type: 'runtime.set_tool_enabled',
      ts: this.deps.clock.nowMs(),
      payload: { toolId, enabled },
    });
  }

  private async refreshGatewayLedgerFromRuntime(): Promise<void> {
    this.deps.gatewayLedger.setAll(await this.deps.runtimeDriver.listInstalledTools());
  }
}
