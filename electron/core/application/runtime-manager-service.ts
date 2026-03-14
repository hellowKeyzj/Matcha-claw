import type {
  AgentRuntimeDriver,
  AuditSinkPort,
  ReconcilerPort,
  RuntimeManagerPort,
  ToolRegistryPort,
  ToolId,
  ToolSource,
  HealthStatus,
  ReconcileReport,
} from '../contracts';

export class RuntimeManagerService implements RuntimeManagerPort {
  constructor(
    private readonly runtimeDriver: AgentRuntimeDriver,
    private readonly toolRegistry: ToolRegistryPort,
    private readonly auditSink: AuditSinkPort,
    private readonly reconciler: ReconcilerPort,
  ) {}

  async runtimeHealth(): Promise<HealthStatus> {
    return this.runtimeDriver.healthCheck();
  }

  async installNativeTool(source: ToolSource): Promise<ToolId> {
    const toolId = await this.runtimeDriver.installTool(source);
    const installed = await this.runtimeDriver.listInstalledTools();
    await this.toolRegistry.upsertNative(installed);
    await this.auditSink.append({
      type: 'runtime.install_native_tool',
      ts: Date.now(),
      payload: { toolId, source: source.spec, kind: source.kind },
    });
    return toolId;
  }

  async reconcileNativeTools(): Promise<ReconcileReport> {
    const upstream = await this.runtimeDriver.listInstalledTools();
    await this.toolRegistry.upsertNative(upstream);
    const report = await this.reconciler.reconcileTools();
    await this.auditSink.append({
      type: 'runtime.reconcile_native_tools',
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
