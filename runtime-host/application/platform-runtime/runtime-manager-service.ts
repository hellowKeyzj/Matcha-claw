import type {
  AgentRuntimeDriver,
  RuntimeManagerPort,
  ToolId,
  ToolSource,
  HealthStatus,
  ReconcileReport,
} from '../../shared/platform-runtime-contracts';
import type { PlatformNativeToolWorkflow } from '../workflows/platform-runtime/platform-native-tool-workflow';

export class RuntimeManagerService implements RuntimeManagerPort {
  constructor(
    private readonly runtimeDriver: AgentRuntimeDriver,
    private readonly nativeToolWorkflow: Pick<PlatformNativeToolWorkflow, 'installNativeTool' | 'reconcileNativeTools'>,
  ) {}

  async runtimeHealth(): Promise<HealthStatus> {
    return this.runtimeDriver.healthCheck();
  }

  async installNativeTool(source: ToolSource): Promise<ToolId> {
    return await this.nativeToolWorkflow.installNativeTool(source);
  }

  async reconcileNativeTools(): Promise<ReconcileReport> {
    return await this.nativeToolWorkflow.reconcileNativeTools();
  }
}
