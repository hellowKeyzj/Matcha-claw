import { createAcpClientConnector } from '../../application/agent-runtime/protocol-connectors/acp/acp-client-connector';
import { AcpProtocolAdapter } from '../../application/agent-runtime/protocol-connectors/acp/acp-protocol-adapter';
import { acpEndpointTemplates } from '../../application/agent-runtime/protocol-connectors/acp/acp-profiles';
import { AcpStdioTransport } from '../../application/agent-runtime/protocol-connectors/acp/acp-stdio-transport';
import type { RuntimeConnectorRegistrationFactory } from '../../application/agent-runtime/contracts/runtime-endpoint-types';
import type { RuntimeHostContainer } from '../container';

function createAcpConnectorRegistrationFactory(): RuntimeConnectorRegistrationFactory {
  return {
    create: () => [createAcpClientConnector({
      protocol: new AcpProtocolAdapter(),
      endpoints: acpEndpointTemplates,
      createTransport: (endpoint) => new AcpStdioTransport(endpoint),
    })],
  };
}

export function registerAcpConnectorModule(container: RuntimeHostContainer): void {
  container.contribute('runtime.connectorRegistrationFactories', (): RuntimeConnectorRegistrationFactory => createAcpConnectorRegistrationFactory());
}
