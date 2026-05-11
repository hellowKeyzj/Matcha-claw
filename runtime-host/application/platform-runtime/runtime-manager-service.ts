import type {
  AgentRuntimeDriver,
  AuditSinkPort,
  ReconcilerPort,
  RuntimeManagerPort,
  ToolId,
  ToolRegistryPort,
  ToolSource,
  HealthStatus,
  ReconcileReport,
} from '../../shared/platform-runtime-contracts';
import type { RuntimeClockPort } from '../common/runtime-ports';

export class RuntimeManagerService implements RuntimeManagerPort {
  constructor(
    private readonly runtimeDriver: AgentRuntimeDriver,
    private readonly toolRegistry: ToolRegistryPort,
    private readonly auditSink: AuditSinkPort,
    private readonly reconciler: ReconcilerPort,
    private readonly clock: RuntimeClockPort,
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
      ts: this.clock.nowMs(),
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
      ts: this.clock.nowMs(),
      payload: {
        discovered: report.discovered.length,
        missing: report.missing.length,
        conflicts: report.conflicts.length,
      },
    });
    return report;
  }
}
