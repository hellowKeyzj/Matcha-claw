import type { AssembleRequest, ToolSource } from '../../../shared/platform-runtime-contracts';
import type { RuntimeHostPlatformFacade } from '../../platform-runtime/platform-runtime-port';

export interface PlatformToolRuntimeWorkflowDeps {
  readonly platformRuntime: Pick<RuntimeHostPlatformFacade, 'startRun' | 'abortRun' | 'installNativeTool' | 'reconcileNativeTools'>;
}

export class PlatformToolRuntimeWorkflow {
  constructor(private readonly deps: PlatformToolRuntimeWorkflowDeps) {}

  async executeStartRun(req: AssembleRequest, eventTx: unknown) {
    return {
      runId: await this.deps.platformRuntime.startRun(req, eventTx),
    };
  }

  async executeAbortRun(runId: string): Promise<{ success: true }> {
    await this.deps.platformRuntime.abortRun(runId);
    return { success: true };
  }

  async executeInstallNativeTool(source: ToolSource) {
    return {
      toolId: await this.deps.platformRuntime.installNativeTool(source),
    };
  }

  async executeReconcileTools() {
    return {
      report: await this.deps.platformRuntime.reconcileNativeTools(),
    };
  }
}
