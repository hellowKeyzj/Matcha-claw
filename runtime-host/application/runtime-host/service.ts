import type { RuntimeHostOperationsWorkflow } from '../workflows/runtime-host/runtime-host-operations-workflow';
import type { RuntimeHostStatePort } from './runtime-state';

export interface RuntimeHostEnvironmentPort {
  getRuntimeDataRootDir(): string;
}

export interface RuntimeHostServiceDeps {
  readonly runtimeState: RuntimeHostStatePort;
  readonly operationsWorkflow: Pick<
    RuntimeHostOperationsWorkflow,
    | 'prepareGatewayLaunch'
    | 'providerEnvMap'
    | 'hostBootstrapSettings'
    | 'gatewayLaunchPlan'
    | 'gatewayLifecycle'
    | 'collectDiagnostics'
    | 'runtimeJobs'
    | 'runtimeJob'
  >;
}

export class RuntimeHostService {
  constructor(private readonly deps: RuntimeHostServiceDeps) {}

  health() {
    return this.deps.runtimeState.health();
  }

  transportStats() {
    return this.deps.runtimeState.transportStats();
  }

  prepareGatewayLaunch(payload: unknown) {
    return this.deps.operationsWorkflow.prepareGatewayLaunch(payload);
  }

  providerEnvMap() {
    return this.deps.operationsWorkflow.providerEnvMap();
  }

  async hostBootstrapSettings() {
    return await this.deps.operationsWorkflow.hostBootstrapSettings();
  }

  async gatewayLaunchPlan() {
    return await this.deps.operationsWorkflow.gatewayLaunchPlan();
  }

  gatewayLifecycle(payload: unknown) {
    return this.deps.operationsWorkflow.gatewayLifecycle(payload);
  }

  async collectDiagnostics(payload: unknown) {
    return await this.deps.operationsWorkflow.collectDiagnostics(payload);
  }

  runtimeJobs(payload: unknown) {
    return this.deps.operationsWorkflow.runtimeJobs(payload);
  }

  runtimeJob(payload: unknown) {
    return this.deps.operationsWorkflow.runtimeJob(payload);
  }
}
