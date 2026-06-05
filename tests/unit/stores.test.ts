/**
 * Zustand Stores Tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { hostApiFetchMock, hostCapabilityExecuteMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';

describe('Settings Store', () => {
  beforeEach(() => {
    // Reset store to default state
    hostApiFetchMock.mockReset();
    hostCapabilityExecuteMock.mockReset();
    useSettingsStore.setState({
      theme: 'system',
      language: 'en',
      devModeUnlocked: false,
      gatewayAutoStart: true,
      gatewayPort: 18789,
      autoCheckUpdate: true,
      startMinimized: false,
      launchAtStartup: false,
      updateChannel: 'stable',
    });
  });
  
  it('should have default values', () => {
    const state = useSettingsStore.getState();
    expect(state.theme).toBe('system');
    expect(state.gatewayAutoStart).toBe(true);
  });
  
  it('should update theme', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true });
    const { setTheme } = useSettingsStore.getState();
    await setTheme('dark');
    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('should unlock dev mode', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true });
    const { setDevModeUnlocked } = useSettingsStore.getState();
    await setDevModeUnlocked(true);
    expect(useSettingsStore.getState().devModeUnlocked).toBe(true);
  });

  it('should persist renderer-owned settings through host settings routes', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true });

    const { setAutoCheckUpdate, setDevModeUnlocked } = useSettingsStore.getState();
    await setAutoCheckUpdate(false);
    await setDevModeUnlocked(true);

    expect(useSettingsStore.getState().autoCheckUpdate).toBe(false);
    expect(useSettingsStore.getState().devModeUnlocked).toBe(true);

    await waitFor(() => {
      expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'settings.runtime',
          operationId: 'settings.setValue',
          input: expect.objectContaining({ key: 'autoCheckUpdate', value: false }),
        }),
        undefined,
      );
      expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'settings.runtime',
          operationId: 'settings.setValue',
          input: expect.objectContaining({ key: 'devModeUnlocked', value: true }),
        }),
        undefined,
      );
    });
  });

  it('should persist launch-at-startup setting through host api', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true });

    const { setLaunchAtStartup } = useSettingsStore.getState();
    await setLaunchAtStartup(true);

    expect(useSettingsStore.getState().launchAtStartup).toBe(true);
    await waitFor(() => {
      expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'settings.runtime',
          operationId: 'settings.setValue',
          input: expect.objectContaining({ key: 'launchAtStartup', value: true }),
        }),
        undefined,
      );
    });
  });

  it('should keep previous local value when host settings write fails', async () => {
    hostApiFetchMock.mockRejectedValueOnce(new Error('write failed'));
    const { setTheme } = useSettingsStore.getState();

    await expect(setTheme('dark')).rejects.toThrow('write failed');
    expect(useSettingsStore.getState().theme).toBe('system');
  });
});

describe('Layout Store', () => {
  beforeEach(() => {
    window.localStorage.removeItem('layout:sidebar-visible');
    window.localStorage.removeItem('layout:sidebar-width');
    useLayoutStore.setState({
      sidebarVisible: true,
      sidebarWidth: 256,
      chatTakeoverMode: 'none',
    });
  });

  it('should have default values', () => {
    const state = useLayoutStore.getState();
    expect(state.sidebarVisible).toBe(true);
    expect(state.sidebarWidth).toBe(256);
    expect(state.chatTakeoverMode).toBe('none');
  });

  it('should toggle sidebar visibility', () => {
    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarVisible).toBe(false);
  });

  it('should set and clear chat takeover mode', () => {
    useLayoutStore.getState().setChatTakeoverMode('artifact-workbench');
    expect(useLayoutStore.getState().chatTakeoverMode).toBe('artifact-workbench');

    useLayoutStore.getState().clearChatTakeoverMode();
    expect(useLayoutStore.getState().chatTakeoverMode).toBe('none');
  });
});

describe('Gateway Store', () => {
  beforeEach(() => {
    // Reset store
    useGatewayStore.setState({
      status: {
        processState: 'stopped',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 0,
      },
      isInitialized: false,
      lastError: null,
      health: null,
      runtimeHost: {
        lifecycle: 'unknown',
        restartCount: 0,
      },
    });
    resetGatewayClientMocks();
  });
  
  it('should have default status', () => {
    const state = useGatewayStore.getState();
    expect(state.status.processState).toBe('stopped');
    expect(state.status.port).toBe(18789);
  });
  
  it('should update status', () => {
    const { setStatus } = useGatewayStore.getState();
    setStatus({
      processState: 'running',
      port: 18789,
      pid: 12345,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1,
    });
    
    const state = useGatewayStore.getState();
    expect(state.status.processState).toBe('running');
    expect(state.status.pid).toBe(12345);
  });

  it('should refresh gateway status from host after start command succeeds', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        processState: 'starting',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'degraded',
        transportState: 'reconnecting',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      });

    await useGatewayStore.getState().start();

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/gateway/start',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/gateway/status', undefined);
    expect(useGatewayStore.getState().status.processState).toBe('starting');
    expect(useGatewayStore.getState().lastError).toBeNull();
  });

  it('should keep observed lifecycle unchanged when restart command fails', async () => {
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
      lastError: null,
    });
    hostApiFetchMock.mockResolvedValueOnce({ success: false, error: 'restart denied' });

    await useGatewayStore.getState().restart();

    expect(useGatewayStore.getState().status.processState).toBe('running');
    expect(useGatewayStore.getState().lastError).toBe('restart denied');
  });
});
