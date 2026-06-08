import type { RuntimeEndpointRef } from '../agent-runtime/contracts/runtime-address';
import type { SessionUpdateEvent } from '../../shared/session-adapter-types';
import type { CanonicalApprovalNotification } from './canonical/canonical-approval-events';
import type { SessionGatewayIngressWorkflow } from '../workflows/session-gateway-ingress/session-gateway-ingress-workflow';

export interface SessionGatewayIngressServiceDeps {
  ingressWorkflow: Pick<SessionGatewayIngressWorkflow, 'consumeEndpointNotification' | 'consumeEndpointConversationEvent'>;
  emitSessionUpdate?: (event: SessionUpdateEvent) => void;
}

export class SessionGatewayIngressService {
  constructor(private readonly deps: SessionGatewayIngressServiceDeps) {}

  consumeEndpointNotification(endpoint: RuntimeEndpointRef, notification: CanonicalApprovalNotification): SessionUpdateEvent[] {
    return this.emitUpdates(this.deps.ingressWorkflow.consumeEndpointNotification(endpoint, notification));
  }

  async consumeEndpointConversationEvent(endpoint: RuntimeEndpointRef, payload: unknown): Promise<SessionUpdateEvent[]> {
    return this.emitUpdates(await this.deps.ingressWorkflow.consumeEndpointConversationEvent(endpoint, payload));
  }

  private emitUpdates(events: SessionUpdateEvent[]): SessionUpdateEvent[] {
    for (const event of events) {
      this.deps.emitSessionUpdate?.(event);
    }
    return events;
  }
}
