import { ipcMain } from 'electron';
import type { FleetCredentialsTransport } from '../../main/runtime-host-delivery/transport/fleet-credentials';

export function registerFleetPrivateHandlers(transport: FleetCredentialsTransport): void {
  ipcMain.handle('fleet:writeCredential', async (_, input: unknown) => {
    return await transport.write(input);
  });
}
