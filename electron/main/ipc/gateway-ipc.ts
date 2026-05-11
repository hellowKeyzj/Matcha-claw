import { ipcMain } from 'electron';
import { GatewayManager } from '../../gateway/manager';
import { buildPublicGatewayStatus } from '../../gateway/public-status';
import type { RuntimeHostManager } from '../runtime-host-manager';
import { getE2EGatewayStatus } from '../e2e-fixture-loader';

export function registerGatewayHandlers(
  gatewayManager: GatewayManager,
  runtimeHost?: RuntimeHostManager,
): void {
  ipcMain.handle('gateway:status', async () => {
    const e2eStatus = await getE2EGatewayStatus();
    if (e2eStatus) {
      return e2eStatus;
    }
    const gatewayStatus = gatewayManager.getStatus();
    const runtimeStatus = runtimeHost
      ? await runtimeHost.readGatewayStatus().catch(() => null)
      : null;
    return buildPublicGatewayStatus(gatewayStatus, runtimeStatus);
  });
}
