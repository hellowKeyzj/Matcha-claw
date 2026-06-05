import { createAcpClientConnector } from '../../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-client-connector';
import { AcpProtocolAdapter } from '../../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-protocol-adapter';
import { acpEndpointTemplates } from '../../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-profiles';
import { AcpStdioTransport } from '../../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-stdio-transport';
import type { RuntimeEndpointProfile, RuntimeSessionTransport } from '../../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';

export function createTestAcpClientConnector(options?: {
  createTransport?: (endpoint: RuntimeEndpointProfile) => RuntimeSessionTransport & { stop?: () => void };
}) {
  return createAcpClientConnector({
    protocol: new AcpProtocolAdapter(),
    endpoints: acpEndpointTemplates,
    createTransport: options?.createTransport ?? ((endpoint) => new AcpStdioTransport(endpoint)),
  });
}
