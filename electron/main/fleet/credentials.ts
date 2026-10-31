import type {
  FleetCredentialsTransport,
  RemoteFleetCredentialWriteAdapter,
} from '../runtime-host-delivery/transport/fleet-credentials';

export function createFleetCredentialWriteAdapter(
  transport: FleetCredentialsTransport,
): RemoteFleetCredentialWriteAdapter {
  return (input) => transport.write(input);
}
