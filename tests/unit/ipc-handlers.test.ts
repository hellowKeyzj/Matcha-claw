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
  registerProviderValidationHandlers: vi.fn(),
  registerFleetPrivateHandlers: vi.fn(),
  registerDiagnosticsExportHandler: vi.fn(),
}));

vi.mock('../../electron/main/ipc/gateway-ipc', () => ({
  registerGatewayHandlers: mocks.registerGatewayHandlers,
}));
vi.mock('../../electron/main/ipc/shell-ipc', () => ({
  registerShellHandlers: mocks.registerShellHandlers,
}));
vi.mock('../../electron/main/ipc/dialog-ipc', () => ({
  registerDialogHandlers: mocks.registerDialogHandlers,
}));
vi.mock('../../electron/main/ipc/app-ipc', () => ({
  registerAppHandlers: mocks.registerAppHandlers,
}));
vi.mock('../../electron/main/ipc/window-ipc', () => ({
  registerWindowHandlers: mocks.registerWindowHandlers,
}));
vi.mock('../../electron/main/ipc/hostapi-proxy-ipc', () => ({
  registerHostApiProxyHandlers: mocks.registerHostApiProxyHandlers,
}));
vi.mock('../../electron/main/ipc/settings-private-proxy', () => ({
  registerSettingsPrivateProxyHandlers: mocks.registerSettingsPrivateProxyHandlers,
}));
vi.mock('../../electron/main/ipc/provider-private-auth', () => ({
  registerProviderPrivateAuthHandlers: mocks.registerProviderPrivateAuthHandlers,
}));
vi.mock('../../electron/main/ipc/provider-validation', () => ({
  registerProviderValidationHandlers: mocks.registerProviderValidationHandlers,
}));
vi.mock('../../electron/main/ipc/fleet-private', () => ({
  registerFleetPrivateHandlers: mocks.registerFleetPrivateHandlers,
}));
vi.mock('../../electron/main/ipc/diagnostics-export-ipc', () => ({
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
      onExit: vi.fn(),
      stop: vi.fn(),
      forceKill: vi.fn(),
    };
    const getMainWindow = vi.fn(() => null);
    const { registerIpcHandlers } = await import('../../electron/main/ipc-handlers');

    registerIpcHandlers(runtimeHost, getMainWindow, { execute: vi.fn() }, {
      transport: { download: vi.fn() },
      showSaveDialog: vi.fn(),
      writeFile: vi.fn(),
      getE2ESavePath: vi.fn(),
    });

    expect(mocks.registerHostApiProxyHandlers).toHaveBeenCalledOnce();
    expect(mocks.registerGatewayHandlers).toHaveBeenCalledOnce();
    expect(mocks.registerGatewayHandlers).toHaveBeenCalledWith(runtimeHost);
    expect(mocks.registerWindowHandlers).toHaveBeenCalledWith(getMainWindow);
  });
});
