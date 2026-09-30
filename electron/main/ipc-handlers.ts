/**
 * IPC Handlers
 * Registers all IPC handlers for main-renderer communication
 */
import type { BrowserWindow } from 'electron';
import type { DirectRuntimeHost } from './runtime-host-delivery/direct-host';
import { registerShellHandlers } from './ipc/shell-ipc';
import { registerDialogHandlers } from './ipc/dialog-ipc';
import { registerAppHandlers } from './ipc/app-ipc';
import { registerWindowHandlers } from './ipc/window-ipc';
import { registerGatewayHandlers } from './ipc/gateway-ipc';
import { registerHostApiProxyHandlers } from './ipc/hostapi-proxy-ipc';
import { registerSettingsPrivateProxyHandlers } from './ipc/settings-private-proxy';
import { registerProviderPrivateAuthHandlers, type AwaitProviderCall } from './ipc/provider-private-auth';
import { registerFleetPrivateHandlers } from './ipc/fleet-private';
import type { FleetCredentialsTransport } from './runtime-host-delivery/transport/fleet-credentials';
import type { ProviderAccountsTransport } from './runtime-host-delivery/transport/providers/accounts';
import { registerDiagnosticsExportHandler } from './ipc/diagnostics-export-ipc';
import type { DiagnosticsExportDependencies } from './ipc/diagnostics-export-ipc';

/**
 * Register all IPC handlers
 */
export function registerStaticIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
): void {
  registerHostApiProxyHandlers();
  registerSettingsPrivateProxyHandlers();
  registerShellHandlers();
  registerDialogHandlers();
  registerAppHandlers();
  registerWindowHandlers(getMainWindow);
}

export function registerRuntimeIpcHandlers(
  runtimeHost: DirectRuntimeHost,
  getMainWindow: () => BrowserWindow | null,
  providerAccountsTransport: ProviderAccountsTransport,
  awaitProviderCall: AwaitProviderCall,
  fleetCredentialsTransport: FleetCredentialsTransport,
  diagnosticsExportDependencies: DiagnosticsExportDependencies,
): void {
  registerProviderPrivateAuthHandlers(getMainWindow, providerAccountsTransport, awaitProviderCall);
  registerFleetPrivateHandlers(fleetCredentialsTransport);
  registerDiagnosticsExportHandler(diagnosticsExportDependencies);
  registerGatewayHandlers(runtimeHost);
}

export function registerIpcHandlers(
  runtimeHost: DirectRuntimeHost,
  getMainWindow: () => BrowserWindow | null,
  providerAccountsTransport: ProviderAccountsTransport,
  awaitProviderCall: AwaitProviderCall,
  fleetCredentialsTransport: FleetCredentialsTransport,
  diagnosticsExportDependencies: DiagnosticsExportDependencies,
): void {
  registerStaticIpcHandlers(getMainWindow);
  registerRuntimeIpcHandlers(
    runtimeHost,
    getMainWindow,
    providerAccountsTransport,
    awaitProviderCall,
    fleetCredentialsTransport,
    diagnosticsExportDependencies,
  );
}
