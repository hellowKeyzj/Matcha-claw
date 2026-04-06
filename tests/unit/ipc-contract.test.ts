import { describe, expect, it } from 'vitest';
import {
  INFRASTRUCTURE_TRANSPORT_INVOKE_CHANNELS,
  RETAINED_EVENT_CHANNELS,
  RETAINED_INVOKE_CHANNELS,
  RETAINED_ONCE_CHANNELS,
  RUNTIME_OWNED_INVOKE_CHANNELS,
  SHELL_INVOKE_CHANNELS,
  TOOLCHAIN_AND_UPDATE_INVOKE_CHANNELS,
  isRetainedEventChannel,
  isRetainedInvokeChannel,
  isRetainedOnceChannel,
} from '../../electron/preload/ipc-contract';

describe('ipc contract', () => {
  it('保留 IPC invoke 清单不包含已收口的业务通道', () => {
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('settings:getAll');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('settings:setMany');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('provider:listAccounts');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('cron:list');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('clawhub:search');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('chat:sendWithMedia');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('media:getThumbnails');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('log:getRecent');
  });

  it('保留 IPC invoke 清单覆盖当前仍应保留的壳层/基础设施通道', () => {
    expect(INFRASTRUCTURE_TRANSPORT_INVOKE_CHANNELS).toContain('hostapi:fetch');
    expect(INFRASTRUCTURE_TRANSPORT_INVOKE_CHANNELS).toContain('gateway:rpc');
    expect(SHELL_INVOKE_CHANNELS).toContain('dialog:open');
    expect(SHELL_INVOKE_CHANNELS).toContain('shell:showItemInFolder');
    expect(SHELL_INVOKE_CHANNELS).toContain('window:minimize');
    expect(RUNTIME_OWNED_INVOKE_CHANNELS).toHaveLength(0);
    expect(TOOLCHAIN_AND_UPDATE_INVOKE_CHANNELS).toContain('update:check');
  });

  it('不再把基础设施/运行时控制 IPC 误标为壳能力', () => {
    expect(SHELL_INVOKE_CHANNELS).not.toContain('gateway:rpc');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('task:pluginInstall');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('team:init');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('openclaw:getCliCommand');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('uv:install-all');
  });

  it('移除当前 renderer 无调用面的旧直连控制通道', () => {
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('gateway:start');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('gateway:stop');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('gateway:restart');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('gateway:health');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('gateway:isConnected');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('app:getPath');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('app:quit');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('app:relaunch');
    expect(RETAINED_INVOKE_CHANNELS).not.toContain('app:request');
  });

  it('保留 IPC 事件清单与 once 清单可正确判定', () => {
    expect(new Set(RETAINED_EVENT_CHANNELS).size).toBe(RETAINED_EVENT_CHANNELS.length);
    expect(new Set(RETAINED_ONCE_CHANNELS).size).toBe(RETAINED_ONCE_CHANNELS.length);

    expect(isRetainedEventChannel('navigate')).toBe(true);
    expect(isRetainedEventChannel('oauth:success')).toBe(false);
    expect(isRetainedEventChannel('log:getRecent')).toBe(false);

    expect(isRetainedOnceChannel('update:error')).toBe(true);
    expect(isRetainedOnceChannel('openclaw:cli-installed')).toBe(false);

    expect(isRetainedInvokeChannel('gateway:rpc')).toBe(true);
    expect(isRetainedInvokeChannel('settings:getAll')).toBe(false);
  });
});
