export const INFRASTRUCTURE_TRANSPORT_INVOKE_CHANNELS = [
  'hostapi:fetch',
  'hostapi:token',
  'gateway:status',
  'gateway:rpc',
  'gateway:httpProxy',
  'gateway:getControlUiUrl',
] as const;

export const SHELL_INVOKE_CHANNELS = [
  'app:version',
  'app:name',
  'app:platform',
  'window:minimize',
  'window:maximize',
  'window:close',
  'window:isMaximized',
  'shell:openExternal',
  'shell:openChromeExtensions',
  'shell:showItemInFolder',
  'shell:openPath',
  'dialog:open',
  'dialog:save',
  'dialog:message',
] as const;

export const TOOLCHAIN_AND_UPDATE_INVOKE_CHANNELS = [
  'update:status',
  'update:version',
  'update:check',
  'update:download',
  'update:install',
  'update:setChannel',
  'update:setAutoDownload',
  'update:cancelAutoInstall',
] as const;

export const ENVIRONMENT_QUERY_INVOKE_CHANNELS = [
] as const;

export const RUNTIME_OWNED_INVOKE_CHANNELS = [
] as const;

export const LEGACY_COMPAT_INVOKE_CHANNELS = [
] as const;

export const RETAINED_INVOKE_CHANNELS = [
  ...INFRASTRUCTURE_TRANSPORT_INVOKE_CHANNELS,
  ...SHELL_INVOKE_CHANNELS,
  ...TOOLCHAIN_AND_UPDATE_INVOKE_CHANNELS,
  ...ENVIRONMENT_QUERY_INVOKE_CHANNELS,
  ...RUNTIME_OWNED_INVOKE_CHANNELS,
  ...LEGACY_COMPAT_INVOKE_CHANNELS,
] as const;

export const RETAINED_EVENT_CHANNELS = [
  'navigate',
  'host:event',
  'update:status-changed',
  'update:checking',
  'update:available',
  'update:not-available',
  'update:progress',
  'update:downloaded',
  'update:error',
  'update:auto-install-countdown',
  'openclaw:cli-installed',
  'cron:updated',
] as const;

export const RETAINED_ONCE_CHANNELS = [
  'navigate',
  'host:event',
  'update:status-changed',
  'update:checking',
  'update:available',
  'update:not-available',
  'update:progress',
  'update:downloaded',
  'update:error',
  'update:auto-install-countdown',
] as const;

const retainedInvokeChannelSet = new Set<string>(RETAINED_INVOKE_CHANNELS);
const retainedEventChannelSet = new Set<string>(RETAINED_EVENT_CHANNELS);
const retainedOnceChannelSet = new Set<string>(RETAINED_ONCE_CHANNELS);

export function isRetainedInvokeChannel(channel: string): boolean {
  return retainedInvokeChannelSet.has(channel);
}

export function isRetainedEventChannel(channel: string): boolean {
  return retainedEventChannelSet.has(channel);
}

export function isRetainedOnceChannel(channel: string): boolean {
  return retainedOnceChannelSet.has(channel);
}
