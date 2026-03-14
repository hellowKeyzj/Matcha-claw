import type {
  AgentRuntimeDriver,
  AuditSinkPort,
  HealthStatus,
  ReconcileReport,
  ReconcilerPort,
  RuntimeManagerPort,
  ToolRegistryPort,
  ToolSource,
  ToolId,
} from '../../core/contracts';
import type { GatewayPluginStateLedger } from './ledger';

export class RuntimeManagerAdapter implements RuntimeManagerPort {
  constructor(
    private readonly runtimeDriver: AgentRuntimeDriver,
    private readonly toolRegistry: ToolRegistryPort,
    private readonly gatewayLedger: GatewayPluginStateLedger,
    private readonly reconciler: ReconcilerPort,
    private readonly auditSink: AuditSinkPort,
  ) {}

  async runtimeHealth(): Promise<HealthStatus> {
    return this.runtimeDriver.healthCheck();
  }

  async installNativeTool(source: ToolSource): Promise<ToolId> {
    const toolId = await this.runtimeDriver.installTool(source);
    const tools = await this.runtimeDriver.listInstalledTools();
    this.gatewayLedger.setAll(tools);
    await this.toolRegistry.upsertNative(tools);
    await this.auditSink.append({
      type: 'runtime_manager.install_native_tool',
      ts: Date.now(),
      payload: {
        toolId,
        source: source.spec,
      },
    });
    return toolId;
  }

  async reconcileNativeTools(): Promise<ReconcileReport> {
    const tools = await this.runtimeDriver.listInstalledTools();
    this.gatewayLedger.setAll(tools);
    await this.toolRegistry.upsertNative(tools);
    const report = await this.reconciler.reconcileTools();
    await this.auditSink.append({
      type: 'runtime_manager.reconcile_native_tools',
      ts: Date.now(),
      payload: {
        discovered: report.discovered.length,
        missing: report.missing.length,
        conflicts: report.conflicts.length,
      },
    });
    return report;
  }
}
