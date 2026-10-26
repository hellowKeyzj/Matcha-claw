import { notes } from '@serenity-js/core';
import { Attribute, Text, Value } from '@serenity-js/web';
import { ProxyPage } from '../pages/proxy.page.js';

export const ProxySettingsIsVisible = () => ProxyPage.section.isVisible().describedAs('proxy settings are visible');
export const ProxySwitchIsVisible = () => ProxyPage.toggle.isVisible().describedAs('proxy switch is visible');
export const ProxySaveIsEnabled = () => ProxyPage.save.isEnabled().describedAs('proxy settings save is enabled');
export const ProxySwitchState = () => Attribute.called('data-state').of(ProxyPage.toggle);
export const ProxyServer = () => Value.of(ProxyPage.server);
export const ProxyBypassRules = () => Value.of(ProxyPage.bypass);
export const ProxyResource = () => notes<{
  proxyResource: {
    server: string; bypassRules: string;
    baseline: { proxyEnabled: boolean; proxyServer: string; proxyBypassRules: string };
  };
}>().get('proxyResource');
export const ProxyBaselineSwitchState = () => ProxyResource().baseline.proxyEnabled.as(enabled => enabled ? 'checked' : 'unchecked');
export const ProxyCleanupAction = () => notes<{ proxyCleanupAction: 'none' | 'discard' | 'restore' }>().get('proxyCleanupAction');
export const ProxyPublicSettingsMatch = () => notes<{ proxyPublicSettingsMatch: boolean }>().get('proxyPublicSettingsMatch');
export const ProxySaveReceipt = () => notes().get('proxySaveReceipt');
export const ProxySaveLabel = () => Text.of(ProxyPage.save);
export const ProxySaveSucceeded = () => ProxyPage.saved.isVisible().describedAs('proxy settings save succeeded');
