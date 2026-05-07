import { PORTS } from '../utils/config';
import { logger } from '../utils/logger';
import type { GatewayStatus } from './manager';

type GatewayStateHooks = {
  emitStatus: (status: GatewayStatus) => void;
  onTransition?: (previousProcessState: GatewayStatus['processState'], nextProcessState: GatewayStatus['processState']) => void;
};

export class GatewayStateController {
  private status: GatewayStatus = { processState: 'stopped', port: PORTS.OPENCLAW_GATEWAY };

  constructor(private readonly hooks: GatewayStateHooks) {}

  getStatus(): GatewayStatus {
    return { ...this.status };
  }

  isConnected(isSocketOpen: boolean): boolean {
    return this.status.processState === 'running' && isSocketOpen;
  }

  setStatus(update: Partial<GatewayStatus>): void {
    const previousProcessState = this.status.processState;
    this.status = { ...this.status, ...update };

    if (this.status.processState === 'running' && this.status.connectedAt) {
      this.status.uptime = Date.now() - this.status.connectedAt;
    }

    this.hooks.emitStatus(this.status);

    if (previousProcessState !== this.status.processState) {
      logger.debug(`Gateway processState changed: ${previousProcessState} -> ${this.status.processState}`);
      this.hooks.onTransition?.(previousProcessState, this.status.processState);
    }
  }
}
