import { ipcMain } from 'electron';
import type {
  RemoteFleetCredentialWriteAdapter,
  RemoteFleetCredentialWriteReceipt,
} from '../runtime-host-delivery/transport/fleet-credentials';
export {
  RemoteFleetCredentialWriteError,
  isRemoteFleetCredentialWriteError,
  isRemoteFleetCredentialWriteInput,
} from '../runtime-host-delivery/transport/fleet-credentials';
export type {
  RemoteFleetCredentialName,
  RemoteFleetCredentialRef,
  RemoteFleetCredentialWriteAdapter,
  RemoteFleetCredentialWriteErrorKind,
  RemoteFleetCredentialWriteErrorStatus,
  RemoteFleetCredentialWriteInput,
  RemoteFleetCredentialWriteReceipt,
} from '../runtime-host-delivery/transport/fleet-credentials';

export type RemoteFleetCredentialWriteTransport = Readonly<{
  write(input: unknown): Promise<RemoteFleetCredentialWriteReceipt>;
}>;

export function createFleetCredentialWriteAdapter(
  transport: RemoteFleetCredentialWriteTransport,
): RemoteFleetCredentialWriteAdapter {
  return (input) => transport.write(input);
}

export function registerFleetPrivateHandlers(transport: RemoteFleetCredentialWriteTransport): void {
  ipcMain.handle('fleet:writeCredential', async (_, input: unknown) => {
    return await transport.write(input);
  });
}

