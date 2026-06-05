import type {
  RuntimeConnectorId,
  RuntimeEndpointId,
  RuntimeEndpointProfile,
  RuntimeEndpointReadiness,
  RuntimeProtocolAdapter,
  RuntimeProtocolConnector,
  RuntimeSessionTransport,
} from '../../contracts/runtime-endpoint-types';
import { ACP_CLIENT_CONNECTOR_ID } from './acp-identity';

export interface AcpClientConnectorDeps {
  readonly connectorId?: RuntimeConnectorId;
  readonly protocol: RuntimeProtocolAdapter;
  readonly endpoints: readonly RuntimeEndpointProfile[];
  readonly createTransport: (endpoint: RuntimeEndpointProfile) => RuntimeSessionTransport & { stop?: () => void };
}

export function createAcpClientConnector(deps: AcpClientConnectorDeps): AcpClientConnector {
  return new AcpClientConnector(deps);
}

export class AcpClientConnector implements RuntimeProtocolConnector {
  readonly connectorId: RuntimeConnectorId;
  readonly protocol: RuntimeProtocolAdapter;
  readonly endpoints: RuntimeEndpointProfile[];
  private readonly endpointTemplatesById: Map<RuntimeEndpointId, RuntimeEndpointProfile>;
  private readonly transports = new Map<RuntimeEndpointId, RuntimeSessionTransport & { stop?: () => void }>();

  constructor(private readonly deps: AcpClientConnectorDeps) {
    this.connectorId = deps.connectorId ?? ACP_CLIENT_CONNECTOR_ID;
    this.protocol = deps.protocol;
    this.endpoints = [...deps.endpoints];
    this.endpointTemplatesById = new Map(this.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  }

  connect(endpoint: RuntimeEndpointProfile): RuntimeSessionTransport {
    this.assertConnectorEndpoint(endpoint);
    const existing = this.transports.get(endpoint.id);
    if (existing) {
      return existing;
    }
    const transport = this.deps.createTransport(endpoint);
    this.transports.set(endpoint.id, transport);
    return transport;
  }

  disconnect(endpointId: RuntimeEndpointId): void {
    this.assertKnownEndpointId(endpointId);
    const transport = this.transports.get(endpointId);
    if (!transport) {
      return;
    }
    this.transports.delete(endpointId);
    transport.stop?.();
  }

  async inspectEndpointReadiness(endpointId: RuntimeEndpointId): Promise<RuntimeEndpointReadiness> {
    this.assertKnownEndpointId(endpointId);
    const transport = this.transports.get(endpointId);
    if (!transport) {
      return {
        ready: false,
        phase: 'disconnected',
      };
    }
    return await transport.inspectReadiness?.() ?? {
      ready: true,
      phase: 'connected',
    };
  }

  private assertKnownEndpointId(endpointId: RuntimeEndpointId): void {
    if (!this.endpointTemplatesById.has(endpointId)) {
      throw new Error(`ACP endpoint not registered: ${endpointId}`);
    }
  }

  private assertConnectorEndpoint(endpoint: RuntimeEndpointProfile): void {
    this.assertKnownEndpointId(endpoint.id);
    if (endpoint.protocolId !== this.protocol.protocolId || endpoint.connectorId !== this.connectorId) {
      throw new Error(`ACP endpoint does not belong to connector: ${endpoint.id}`);
    }
  }
}
