/**
 * IPC Handlers
 * Registers all IPC handlers for main-renderer communication
 */
import type { BrowserWindow } from 'electron';
import type { DirectRuntimeHost } from './runtime-host-delivery/direct-host';
import type { RendererSessionObservationRegistry } from './renderer-event-routes';
import { registerShellHandlers } from './ipc/shell-ipc';
import { registerDialogHandlers } from './ipc/dialog-ipc';
import { registerAppHandlers } from './ipc/app-ipc';
import { registerWindowHandlers } from './ipc/window-ipc';
import { registerGatewayHandlers } from './ipc/gateway-ipc';
import { registerHostApiProxyHandlers } from './ipc/hostapi-proxy-ipc';
import { registerSettingsPrivateProxyHandlers } from './ipc/settings-private-proxy';
import { registerProviderPrivateAuthHandlers, type ProviderPrivateAccountDependencies } from './ipc/provider-private-auth';
import { registerFleetPrivateHandlers } from './ipc/fleet-private';
import type { FleetCredentialsTransport } from './runtime-host-delivery/transport/fleet-credentials';
import { registerDiagnosticsExportHandler } from './ipc/diagnostics-export-ipc';
import type { DiagnosticsExportDependencies } from './ipc/diagnostics-export-ipc';

/**
 * Register all IPC handlers
 */
export function registerStaticIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
  runtimeReady: Promise<unknown>,
  sessionObservers?: RendererSessionObservationRegistry,
): void {
  registerHostApiProxyHandlers(runtimeReady, sessionObservers);
  registerSettingsPrivateProxyHandlers();
  registerShellHandlers();
  registerDialogHandlers();
  registerAppHandlers();
  registerWindowHandlers(getMainWindow);
}

export function registerRuntimeIpcHandlers(
  runtimeHost: DirectRuntimeHost,
  fleetCredentialsTransport: FleetCredentialsTransport,
  diagnosticsExportDependencies: DiagnosticsExportDependencies,
): void {
  registerFleetPrivateHandlers(fleetCredentialsTransport);
  registerDiagnosticsExportHandler(diagnosticsExportDependencies);
  registerGatewayHandlers(runtimeHost);
}

export function registerIpcHandlers(
  runtimeHost: DirectRuntimeHost,
  getMainWindow: () => BrowserWindow | null,
  providerAuth: Promise<ProviderPrivateAccountDependencies>,
  signal: AbortSignal,
  fleetCredentialsTransport: FleetCredentialsTransport,
  diagnosticsExportDependencies: DiagnosticsExportDependencies,
): void {
  registerStaticIpcHandlers(getMainWindow, Promise.resolve(runtimeHost));
  registerProviderPrivateAuthHandlers(getMainWindow, providerAuth, signal);
  registerRuntimeIpcHandlers(runtimeHost, fleetCredentialsTransport, diagnosticsExportDependencies);
}
