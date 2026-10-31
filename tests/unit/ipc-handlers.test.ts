import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerGatewayHandlers: vi.fn(),
  registerShellHandlers: vi.fn(),
  registerDialogHandlers: vi.fn(),
  registerAppHandlers: vi.fn(),
  registerWindowHandlers: vi.fn(),
  registerHostApiProxyHandlers: vi.fn(),
  registerSettingsPrivateProxyHandlers: vi.fn(),
  registerProviderPrivateAuthHandlers: vi.fn(),
  registerFleetPrivateHandlers: vi.fn(),
  registerDiagnosticsExportHandler: vi.fn(),
}));

vi.mock('../../electron/api/ipc/gateway-ipc', () => ({
  registerGatewayHandlers: mocks.registerGatewayHandlers,
}));
vi.mock('../../electron/api/ipc/shell-ipc', () => ({
  registerShellHandlers: mocks.registerShellHandlers,
}));
vi.mock('../../electron/api/ipc/dialog-ipc', () => ({
  registerDialogHandlers: mocks.registerDialogHandlers,
}));
vi.mock('../../electron/api/ipc/app-ipc', () => ({
  registerAppHandlers: mocks.registerAppHandlers,
}));
vi.mock('../../electron/api/ipc/window-ipc', () => ({
  registerWindowHandlers: mocks.registerWindowHandlers,
}));
vi.mock('../../electron/api/ipc/hostapi-proxy-ipc', () => ({
  registerHostApiProxyHandlers: mocks.registerHostApiProxyHandlers,
}));
vi.mock('../../electron/api/ipc/settings-private-proxy', () => ({
  registerSettingsPrivateProxyHandlers: mocks.registerSettingsPrivateProxyHandlers,
}));
vi.mock('../../electron/api/ipc/provider-private-auth', () => ({
  registerProviderPrivateAuthHandlers: mocks.registerProviderPrivateAuthHandlers,
}));
vi.mock('../../electron/api/ipc/fleet-private', () => ({
  registerFleetPrivateHandlers: mocks.registerFleetPrivateHandlers,
}));
vi.mock('../../electron/api/ipc/diagnostics-export-ipc', () => ({
  registerDiagnosticsExportHandler: mocks.registerDiagnosticsExportHandler,
  createDiagnosticsExportDependencies: vi.fn(),
}));
describe('IPC handler registration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('passes the direct runtime host to gateway IPC without manager dependencies', async () => {
    const runtimeHost = {
      command: vi.fn(),
      onSafeEvent: vi.fn(),
      onDisconnect: vi.fn(),
      onExit: vi.fn(),
      readE2ECronProviderTrace: vi.fn(() => []),
      stop: vi.fn(),
      forceKill: vi.fn(),
    };
    const getMainWindow = vi.fn(() => null);
    const { registerIpcHandlers } = await import('../../electron/api/ipc/register');

    const providerAuthActions = {
      storeAccount: vi.fn(),
      deleteAccount: vi.fn(),
      startOAuth: vi.fn(),
      submitOAuthCode: vi.fn(),
      cancelOAuth: vi.fn(),
    };
    const fleetCredentialsTransport = { write: vi.fn() };
    const diagnostics = {
      transport: { download: vi.fn() },
      showSaveDialog: vi.fn(),
      writeFile: vi.fn(),
      getE2ESavePath: vi.fn(),
    };
    registerIpcHandlers(runtimeHost, getMainWindow, providerAuthActions, fleetCredentialsTransport, diagnostics);

    expect(mocks.registerHostApiProxyHandlers).toHaveBeenCalledOnce();
    expect(mocks.registerGatewayHandlers).toHaveBeenCalledOnce();
    expect(mocks.registerGatewayHandlers).toHaveBeenCalledWith(runtimeHost);
    expect(mocks.registerFleetPrivateHandlers).toHaveBeenCalledWith(fleetCredentialsTransport);
    expect(mocks.registerWindowHandlers).toHaveBeenCalledWith(getMainWindow);
    expect(mocks.registerProviderPrivateAuthHandlers).toHaveBeenCalledWith(providerAuthActions);
    expect(mocks.registerDiagnosticsExportHandler).toHaveBeenCalledWith(diagnostics);
    expect(mocks.registerWindowHandlers.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.registerProviderPrivateAuthHandlers.mock.invocationCallOrder[0],
    );
    expect(mocks.registerProviderPrivateAuthHandlers.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.registerFleetPrivateHandlers.mock.invocationCallOrder[0],
    );
  });
});
