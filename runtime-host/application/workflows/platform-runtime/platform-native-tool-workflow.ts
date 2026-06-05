import type {
  AgentRuntimeDriver,
  AuditSinkPort,
  ReconcilerPort,
  ReconcileReport,
  ToolId,
  ToolRegistryPort,
  ToolSource,
} from '../../../shared/platform-runtime-contracts';
import type { RuntimeClockPort } from '../../common/runtime-ports';

export interface PlatformNativeToolWorkflowDeps {
  readonly runtimeDriver: AgentRuntimeDriver;
  readonly toolRegistry: ToolRegistryPort;
  readonly auditSink: AuditSinkPort;
  readonly reconciler: ReconcilerPort;
  readonly clock: RuntimeClockPort;
}

export class PlatformNativeToolWorkflow {
  constructor(private readonly deps: PlatformNativeToolWorkflowDeps) {}

  async installNativeTool(source: ToolSource): Promise<ToolId> {
    const toolId = await this.deps.runtimeDriver.installTool(source);
    const installed = await this.deps.runtimeDriver.listInstalledTools();
    await this.deps.toolRegistry.upsertNative(installed);
    await this.deps.auditSink.append({
      type: 'runtime.install_native_tool',
      ts: this.deps.clock.nowMs(),
      payload: { toolId, source: source.spec, kind: source.kind },
    });
    return toolId;
  }

  async reconcileNativeTools(): Promise<ReconcileReport> {
    const upstream = await this.deps.runtimeDriver.listInstalledTools();
    await this.deps.toolRegistry.upsertNative(upstream);
    const report = await this.deps.reconciler.reconcileTools();
    await this.deps.auditSink.append({
      type: 'runtime.reconcile_native_tools',
      ts: this.deps.clock.nowMs(),
      payload: {
        discovered: report.discovered.length,
        missing: report.missing.length,
        conflicts: report.conflicts.length,
      },
    });
    return report;
  }
}
