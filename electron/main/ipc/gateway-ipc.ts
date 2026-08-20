import { ipcMain } from 'electron';
import type { DirectRuntimeHost } from '../runtime-host-delivery/direct-host';

type DirectRuntimeHostControl = Pick<DirectRuntimeHost, 'command'>;

export function registerGatewayHandlers(runtimeHost: DirectRuntimeHostControl): void {
  ipcMain.handle('gateway:status', () => runtimeHost.command({
    name: 'host.health',
  }));
}
