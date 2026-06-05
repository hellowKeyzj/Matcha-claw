import type { ToolSource } from '../../shared/platform-runtime-contracts';
import type { PlatformRuntimeOperationsWorkflow } from '../workflows/platform-runtime/platform-runtime-operations-workflow';

interface PlatformServiceDeps {
  readonly operationsWorkflow: Pick<
    PlatformRuntimeOperationsWorkflow,
    | 'runtimeHealth'
    | 'startRun'
    | 'abortRun'
    | 'installNativeTool'
    | 'reconcileTools'
    | 'listTools'
    | 'executeInstallNativeTool'
    | 'executeReconcileTools'
    | 'queryTools'
    | 'upsertPlatformTools'
    | 'setToolEnabled'
  >;
}

export class PlatformService {
  constructor(private readonly deps: PlatformServiceDeps) {}

  async runtimeHealth() {
    return await this.deps.operationsWorkflow.runtimeHealth();
  }

  async startRun(payload: unknown) {
    return await this.deps.operationsWorkflow.startRun(payload);
  }

  async abortRun(payload: unknown) {
    return await this.deps.operationsWorkflow.abortRun(payload);
  }

  async installNativeTool(payload: unknown) {
    return await this.deps.operationsWorkflow.installNativeTool(payload);
  }

  reconcileTools() {
    return this.deps.operationsWorkflow.reconcileTools();
  }

  async listTools(routeUrl: URL) {
    return await this.deps.operationsWorkflow.listTools(routeUrl);
  }

  async executeInstallNativeTool(source: ToolSource) {
    return await this.deps.operationsWorkflow.executeInstallNativeTool(source);
  }

  async executeReconcileTools() {
    return await this.deps.operationsWorkflow.executeReconcileTools();
  }

  async queryTools(payload: unknown) {
    return await this.deps.operationsWorkflow.queryTools(payload);
  }

  async upsertPlatformTools(payload: unknown) {
    return await this.deps.operationsWorkflow.upsertPlatformTools(payload);
  }

  async setToolEnabled(payload: unknown) {
    return await this.deps.operationsWorkflow.setToolEnabled(payload);
  }
}
