/**
 * Zustand Stores Tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsStore } from '@/stores/settings';
import { useRuntimeHostStore } from '@/stores/gateway';

describe('Settings Store', () => {
  beforeEach(() => {
    // Reset store to default state
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
      initialized: false,
    });
  });

  it('should have default values', () => {
    const state = useSettingsStore.getState();
    expect(state.theme).toBe('system');
    expect(state.gatewayAutoStart).toBe(true);
  });

  it('should update theme locally', async () => {
    const { setTheme } = useSettingsStore.getState();
    await setTheme('dark');
    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('should unlock dev mode locally', async () => {
    const { setDevModeUnlocked } = useSettingsStore.getState();
    await setDevModeUnlocked(true);
    expect(useSettingsStore.getState().devModeUnlocked).toBe(true);
  });

  it('should keep renderer-owned settings local', async () => {
    const { setAutoCheckUpdate, setDevModeUnlocked, setLaunchAtStartup } = useSettingsStore.getState();

    await setAutoCheckUpdate(false);
    await setDevModeUnlocked(true);
    await setLaunchAtStartup(true);

    expect(useSettingsStore.getState().autoCheckUpdate).toBe(false);
    expect(useSettingsStore.getState().devModeUnlocked).toBe(true);
    expect(useSettingsStore.getState().launchAtStartup).toBe(true);
  });

  it('should reset renderer-owned settings without replacing sealed desired projection', async () => {
    useSettingsStore.setState({
      theme: 'dark',
      autoCheckUpdate: false,
      devModeUnlocked: true,
      browserMode: 'native',
      proxyEnabled: true,
      proxyServer: 'http://proxy.example.test:8080',
      proxyBypassRules: '<local>',
      initialized: true,
    });

    await useSettingsStore.getState().resetSettings();

    expect(useSettingsStore.getState().theme).toBe('system');
    expect(useSettingsStore.getState().autoCheckUpdate).toBe(true);
    expect(useSettingsStore.getState().devModeUnlocked).toBe(false);
    expect(useSettingsStore.getState()).toMatchObject({
      browserMode: 'native',
      proxyEnabled: true,
      proxyServer: 'http://proxy.example.test:8080',
      proxyBypassRules: '<local>',
      initialized: true,
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

describe('Runtime Host Store', () => {
  beforeEach(() => {
    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'unknown' },
      isInitialized: false,
    });
  });

  it('exposes only the safe lifecycle projection', () => {
    const state = useRuntimeHostStore.getState();
    expect(state.runtimeHost).toEqual({ lifecycle: 'unknown' });
    expect(state).not.toHaveProperty('status');
    expect(state).not.toHaveProperty('start');
    expect(state).not.toHaveProperty('restart');
  });
});
