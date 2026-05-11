import type {
  ParentShellAction,
  ParentTransportUpstreamPayload,
} from '../../shared/parent-transport-contracts';
import type { ApplicationResponse } from '../common/application-response';

export type { ApplicationResponse };

export interface ParentShellPort {
  request(action: ParentShellAction, payload?: unknown): Promise<ParentTransportUpstreamPayload>;
  mapResponse(upstream: ParentTransportUpstreamPayload): ApplicationResponse;
}

export interface GatewayControlPort {
  restartGateway(): Promise<ParentTransportUpstreamPayload>;
}

export class ParentShellGatewayControl implements GatewayControlPort {
  constructor(private readonly parentShell: Pick<ParentShellPort, 'request'>) {}

  async restartGateway(): Promise<ParentTransportUpstreamPayload> {
    return await this.parentShell.request('gateway_restart');
  }
}
