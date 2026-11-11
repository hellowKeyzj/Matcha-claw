/**
 * IPC Handlers
 * Registers all IPC handlers for main-renderer communication
 */
import type { BrowserWindow } from 'electron';
import type { DirectRuntimeHost } from '../../main/runtime-host-delivery/direct-host';
import type { RendererSessionObservationRegistry } from '../../main/sessions/observations';
import type { HostApiDispatcher } from '../execution';
import { registerShellHandlers } from './shell-ipc';
import { registerAppRenderPdfHandlers } from '../../main/app-plugins/render-pdf';
import { registerDialogHandlers } from './dialog-ipc';
import { registerAppHandlers } from './app-ipc';
import { registerWindowHandlers } from './window-ipc';
import { registerGatewayHandlers } from './gateway-ipc';
import { registerHostApiProxyHandlers } from './hostapi-proxy-ipc';
import { registerSettingsPrivateProxyHandlers } from './settings-private-proxy';
import { registerProviderPrivateAuthHandlers } from './provider-private-auth';
import type { ProviderPrivateAuthActions } from '../../main/providers/private-auth';
import { registerFleetPrivateHandlers } from './fleet-private';
import type { FleetCredentialsTransport } from '../../main/runtime-host-delivery/transport/fleet-credentials';
import { registerDiagnosticsExportHandler } from './diagnostics-export-ipc';
import type { DiagnosticsExportDependencies } from './diagnostics-export-ipc';

/**
 * Register all IPC handlers
 */
export function registerStaticIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
  dispatch: HostApiDispatcher,
  runtimeReady: Promise<unknown>,
  sessionObservers: RendererSessionObservationRegistry,
  shutdownSignal: AbortSignal,
): void {
  registerHostApiProxyHandlers(dispatch, runtimeReady, sessionObservers, shutdownSignal);
  registerSettingsPrivateProxyHandlers();
  registerShellHandlers(getMainWindow);
  registerAppRenderPdfHandlers(getMainWindow, shutdownSignal);
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
  providerAuth: ProviderPrivateAuthActions,
  fleetCredentialsTransport: FleetCredentialsTransport,
  diagnosticsExportDependencies: DiagnosticsExportDependencies,
  dispatch: HostApiDispatcher,
  runtimeReady: Promise<unknown>,
  sessionObservers: RendererSessionObservationRegistry,
  shutdownSignal: AbortSignal,
): void {
  registerStaticIpcHandlers(getMainWindow, dispatch, runtimeReady, sessionObservers, shutdownSignal);
  registerProviderPrivateAuthHandlers(providerAuth);
  registerRuntimeIpcHandlers(runtimeHost, fleetCredentialsTransport, diagnosticsExportDependencies);
}
