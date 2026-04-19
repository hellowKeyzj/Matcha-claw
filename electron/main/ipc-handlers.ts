/**
 * IPC Handlers
 * Registers all IPC handlers for main-renderer communication
 */
import type { BrowserWindow } from 'electron';
import { GatewayManager } from '../gateway/manager';
import type { RuntimeHostManager } from './runtime-host-manager';
import { registerHostApiProxyHandlers } from './ipc/hostapi-proxy-ipc';
import { registerShellHandlers } from './ipc/shell-ipc';
import { registerDialogHandlers } from './ipc/dialog-ipc';
import { registerAppHandlers } from './ipc/app-ipc';
import { registerUsageHandlers } from './ipc/usage-ipc';
import { registerWindowHandlers } from './ipc/window-ipc';
import { registerGatewayHandlers } from './ipc/gateway-ipc';

/**
 * Register all IPC handlers
 */
export function registerIpcHandlers(
  gatewayManager: GatewayManager,
  getMainWindow: () => BrowserWindow | null,
  runtimeHost: RuntimeHostManager,
): void {
  // Host API proxy handlers
  registerHostApiProxyHandlers();

  // Gateway handlers
  registerGatewayHandlers(gatewayManager, runtimeHost);

  // Shell handlers
  registerShellHandlers();

  // Dialog handlers
  registerDialogHandlers();

  // App handlers
  registerAppHandlers();

  // Usage handlers
  registerUsageHandlers(runtimeHost);

  // Window control handlers (for custom title bar on Windows)
  registerWindowHandlers(getMainWindow);
}
