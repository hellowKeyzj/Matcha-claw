/**
 * Zustand Stores Tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { gatewayClientRpcMock, hostApiFetchMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';

describe('Settings Store', () => {
  beforeEach(() => {
    // Reset store to default state
    hostApiFetchMock.mockReset();
    useSettingsStore.setState({
      theme: 'system',
      language: 'en',
      devModeUnlocked: false,
      gatewayAutoStart: true,
      gatewayPort: 18789,
      autoCheckUpdate: true,
      autoDownloadUpdate: false,
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
  
  it('should update theme', () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true });
    const { setTheme } = useSettingsStore.getState();
    setTheme('dark');
    expect(useSettingsStore.getState().theme).toBe('dark');
  });
  
  it('should unlock dev mode', () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true });
    const { setDevModeUnlocked } = useSettingsStore.getState();
    setDevModeUnlocked(true);
    expect(useSettingsStore.getState().devModeUnlocked).toBe(true);
  });

  it('should persist renderer-owned settings through host settings routes', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true });

    const { setAutoCheckUpdate, setAutoDownloadUpdate, setDevModeUnlocked } = useSettingsStore.getState();
    setAutoCheckUpdate(false);
    setAutoDownloadUpdate(true);
    setDevModeUnlocked(true);

    expect(useSettingsStore.getState().autoCheckUpdate).toBe(false);
    expect(useSettingsStore.getState().autoDownloadUpdate).toBe(true);
    expect(useSettingsStore.getState().devModeUnlocked).toBe(true);

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/settings/autoCheckUpdate',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ value: false }),
        }),
      );
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/settings/autoDownloadUpdate',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ value: true }),
        }),
      );
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/settings/devModeUnlocked',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ value: true }),
        }),
      );
    });
  });

  it('should persist launch-at-startup setting through host api', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true });

    const { setLaunchAtStartup } = useSettingsStore.getState();
    setLaunchAtStartup(true);

    expect(useSettingsStore.getState().launchAtStartup).toBe(true);
    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/settings/launchAtStartup',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ value: true }),
        }),
      );
    });
  });
});

describe('Layout Store', () => {
  beforeEach(() => {
    window.localStorage.removeItem('layout:sidebar-visible');
    window.localStorage.removeItem('layout:sidebar-width');
    useLayoutStore.setState({
      sidebarVisible: true,
      sidebarWidth: 256,
    });
  });

  it('should have default values', () => {
    const state = useLayoutStore.getState();
    expect(state.sidebarVisible).toBe(true);
    expect(state.sidebarWidth).toBe(256);
  });

  it('should toggle sidebar visibility', () => {
    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarVisible).toBe(false);
  });
});

describe('Gateway Store', () => {
  beforeEach(() => {
    // Reset store
    useGatewayStore.setState({
      status: { state: 'stopped', port: 18789 },
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
    expect(state.status.state).toBe('stopped');
    expect(state.status.port).toBe(18789);
  });
  
  it('should update status', () => {
    const { setStatus } = useGatewayStore.getState();
    setStatus({ state: 'running', port: 18789, pid: 12345 });
    
    const state = useGatewayStore.getState();
    expect(state.status.state).toBe('running');
    expect(state.status.pid).toBe(12345);
  });

  it('should proxy gateway rpc through host gateway transport', async () => {
    gatewayClientRpcMock.mockResolvedValueOnce({ ok: true });

    const result = await useGatewayStore.getState().rpc<{ ok: boolean }>('chat.history', { limit: 10 }, 5000);

    expect(result.ok).toBe(true);
    expect(gatewayClientRpcMock).toHaveBeenCalledWith('chat.history', { limit: 10 }, 5000);
  });

  it('should refresh gateway status from host after start command succeeds', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ state: 'starting', port: 18789 });

    await useGatewayStore.getState().start();

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/gateway/start',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/gateway/status', undefined);
    expect(useGatewayStore.getState().status.state).toBe('starting');
    expect(useGatewayStore.getState().lastError).toBeNull();
  });

  it('should keep observed lifecycle unchanged when restart command fails', async () => {
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      lastError: null,
    });
    hostApiFetchMock.mockResolvedValueOnce({ success: false, error: 'restart denied' });

    await useGatewayStore.getState().restart();

    expect(useGatewayStore.getState().status.state).toBe('running');
    expect(useGatewayStore.getState().lastError).toBe('restart denied');
  });
});
