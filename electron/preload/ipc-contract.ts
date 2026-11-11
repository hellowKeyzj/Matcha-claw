export const INFRASTRUCTURE_TRANSPORT_INVOKE_CHANNELS = [
  'hostapi:fetch',
  'hostapi:abort',
  'hostapi:base-url',
  'gateway:status',
] as const;

export const SHELL_INVOKE_CHANNELS = [
  'iab:command',
  'iab:snapshot',
  'app-plugins:confirmation-owner',
  'app-plugins:confirmation-decide',
  'app-plugins:execution-teams',
  'app-plugins:document-resources-owner',
  'app-plugins:document-resources-create',
  'app-plugins:document-resources-release',
  'app-plugins:document-resources-release-owner',
  'app-plugins:render-pdf',
  'app-plugins:render-pdf-cancel',
  'app-plugins:desktop-media',
  'app-plugins:spellcheck-owner',
  'app-plugins:spellcheck-call',
  'app-plugins:presentation-owner',
  'app-plugins:presentation-request',
  'app-plugins:presentation-release',
  'app-plugins:presentation-bootstrap',
  'app-plugins:presentation-call',
  'app:version',
  'app:name',
  'app:platform',
  'app:graphics-status',
  'app:set-graphics-acceleration',
  'window:minimize',
  'window:maximize',
  'window:close',
  'window:isMaximized',
  'window:setRightDockWidth',
  'window:syncTrafficLightPosition',
  'shell:openExternal',
  'shell:writeClipboardImage',
  'shell:writeClipboard',
  'shell:readClipboard',
  'shell:openResourcePath',
  'shell:openChromeExtensions',
  'shell:showAppLogsDirectory',
  'shell:showItemInFolder',
  'shell:openPath',
  'dialog:open',
  'dialog:save',
  'dialog:message',
  'dialog:stageOpenAttachments',
  'dialog:stageDroppedAttachments',
  'dialog:stageRendererBufferAttachment',
  'dialog:releaseStagedAttachments',
  'dialog:readSelectedTextFile',
  'dialog:readSkillImport',
  'dialog:writeSelectedTextFile',
] as const;

export const TOOLCHAIN_AND_UPDATE_INVOKE_CHANNELS = [
  'update:status',
  'update:version',
  'update:check',
  'update:download',
  'update:install',
  'update:setChannel',
] as const;

export const ENVIRONMENT_QUERY_INVOKE_CHANNELS = [
] as const;

export const DIAGNOSTICS_INVOKE_CHANNELS = [
  'diagnostics:exportArchive',
] as const;

export const RUNTIME_OWNED_INVOKE_CHANNELS = [
  'fleet:writeCredential',
  'world:configureConnection',
  'world:configureStorage',
  'world:prepareAccess',
  'world:commitAccess',
  'world:openStorage',
  'world:prepareEvaluation',
  'world:commitEvaluation',
  'world:evaluationStatus',
  'world:storageStatus',
  'world:transferStorage',
  'settings:splitProxyIntent',
  'providers:storeAccount',
  'providers:deleteAccount',
  'providers:discoverModels',
  'providers:startOAuth',
  'providers:submitOAuthCode',
  'providers:cancelOAuth',
] as const;

export const LEGACY_COMPAT_INVOKE_CHANNELS = [
] as const;

export const RETAINED_INVOKE_CHANNELS = [
  ...INFRASTRUCTURE_TRANSPORT_INVOKE_CHANNELS,
  ...SHELL_INVOKE_CHANNELS,
  ...TOOLCHAIN_AND_UPDATE_INVOKE_CHANNELS,
  ...ENVIRONMENT_QUERY_INVOKE_CHANNELS,
  ...DIAGNOSTICS_INVOKE_CHANNELS,
  ...RUNTIME_OWNED_INVOKE_CHANNELS,
  ...LEGACY_COMPAT_INVOKE_CHANNELS,
] as const;

export const RETAINED_EVENT_CHANNELS = [
  'app-plugins:spellcheck-context-menu',
  'app-plugins:presentation-event',
  'app-plugins:presentation-runtime',
  'navigate',
  'host:event',
  'update:status-changed',
  'update:checking',
  'update:available',
  'update:not-available',
  'update:progress',
  'update:downloaded',
  'update:error',
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
