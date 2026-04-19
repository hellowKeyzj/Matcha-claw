import { describe, expect, it, vi } from 'vitest';
import { handleSettingsRoute } from '../../runtime-host/api/routes/settings-routes';

describe('settings route proxy sync', () => {
  it('PUT /api/settings 显式提交代理字段时会触发 OpenClaw 代理同步（允许清空）', async () => {
    const setSettingsPatchLocal = vi.fn(async () => ({}));
    const syncProxyConfigToOpenClaw = vi.fn(async () => {});

    const result = await handleSettingsRoute(
      'PUT',
      '/api/settings',
      {
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '<local>',
      },
      {
        getAllSettingsLocal: async () => ({
          proxyEnabled: false,
          proxyServer: '',
          proxyBypassRules: '<local>',
        }),
        setSettingsPatchLocal,
        resetSettingsLocal: async () => ({}),
        setSettingValueLocal: async () => ({}),
        syncProxyConfigToOpenClaw,
      },
    );

    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(setSettingsPatchLocal).toHaveBeenCalledWith({
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '<local>',
    });
    expect(syncProxyConfigToOpenClaw).toHaveBeenCalledTimes(1);
    expect(syncProxyConfigToOpenClaw).toHaveBeenCalledWith(
      {
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '<local>',
      },
      { preserveExistingWhenDisabled: false },
    );
  });

  it('PUT /api/settings 未提交代理字段时不触发 OpenClaw 代理同步', async () => {
    const syncProxyConfigToOpenClaw = vi.fn(async () => {});

    await handleSettingsRoute(
      'PUT',
      '/api/settings',
      {
        theme: 'dark',
      },
      {
        getAllSettingsLocal: async () => ({
          theme: 'dark',
          proxyEnabled: true,
          proxyServer: 'http://127.0.0.1:7890',
          proxyBypassRules: '<local>',
        }),
        setSettingsPatchLocal: async () => ({}),
        resetSettingsLocal: async () => ({}),
        setSettingValueLocal: async () => ({}),
        syncProxyConfigToOpenClaw,
      },
    );

    expect(syncProxyConfigToOpenClaw).not.toHaveBeenCalled();
  });

  it('PUT /api/settings 显式提交 browserMode 时会同步 OpenClaw 浏览器模式并重启 Gateway', async () => {
    const syncBrowserModeToOpenClaw = vi.fn(async () => {});
    const requestParentShellAction = vi.fn(async () => ({
      success: true,
      status: 200,
    }));

    const result = await handleSettingsRoute(
      'PUT',
      '/api/settings',
      {
        browserMode: 'native',
      },
      {
        getAllSettingsLocal: async () => ({
          browserMode: 'native',
        }),
        setSettingsPatchLocal: async () => ({}),
        resetSettingsLocal: async () => ({}),
        setSettingValueLocal: async () => ({}),
        syncBrowserModeToOpenClaw,
        requestParentShellAction,
      },
    );

    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(syncBrowserModeToOpenClaw).toHaveBeenCalledWith('native');
    expect(requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
  });

  it('PUT /api/settings/browserMode 也会同步 OpenClaw 浏览器模式并重启 Gateway', async () => {
    const syncBrowserModeToOpenClaw = vi.fn(async () => {});
    const requestParentShellAction = vi.fn(async () => ({
      success: true,
      status: 200,
    }));

    const result = await handleSettingsRoute(
      'PUT',
      '/api/settings/browserMode',
      {
        value: 'off',
      },
      {
        getAllSettingsLocal: async () => ({
          browserMode: 'off',
        }),
        setSettingsPatchLocal: async () => ({}),
        resetSettingsLocal: async () => ({}),
        setSettingValueLocal: async () => ({}),
        syncBrowserModeToOpenClaw,
        requestParentShellAction,
      },
    );

    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(syncBrowserModeToOpenClaw).toHaveBeenCalledWith('off');
    expect(requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
  });
});
