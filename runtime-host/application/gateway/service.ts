import type { GatewayReadinessWorkflow } from '../workflows/gateway-readiness/gateway-readiness-workflow';

export interface GatewayServiceDeps {
  readonly readinessWorkflow: Pick<GatewayReadinessWorkflow, 'status' | 'recover' | 'ready' | 'approvePendingControlUiPairingRequests'>;
}

export class GatewayService {
  constructor(private readonly deps: GatewayServiceDeps) {}

  async status() {
    return await this.deps.readinessWorkflow.status();
  }

  async recover(payload: unknown) {
    return await this.deps.readinessWorkflow.recover(payload);
  }

  async ready(payload: unknown) {
    return await this.deps.readinessWorkflow.ready(payload);
  }

  async approvePendingControlUiPairingRequests() {
    return await this.deps.readinessWorkflow.approvePendingControlUiPairingRequests();
  }
}
