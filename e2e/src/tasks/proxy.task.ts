import { equals, matches, not } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait, type Answerable } from '@serenity-js/core';
import { Click, Enter, isVisible, Navigate } from '@serenity-js/web';
import {
  ArmProxySave, CloseProxyEndpoint, ConfirmProxySave, PlanProxyCleanup, ReadConfirmedProxySettings, RememberProxyBaseline,
} from '../interactions/proxy.interaction.js';
import { ProxyPage } from '../pages/proxy.page.js';
import {
  ProxyBaselineSwitchState, ProxyBypassRules, ProxyCleanupAction, ProxyResource, ProxySaveIsEnabled,
  ProxySaveLabel, ProxySaveSucceeded, ProxyServer, ProxySwitchState,
} from '../questions/proxy.question.js';
import { EnterChat } from './chat.task.js';

export const OpenProxySettings = () => Task.where('#actor opens proxy settings from local Chat',
  EnterChat(),
  Click.on(ProxyPage.openSettings),
  Wait.until(ProxyPage.settings, isVisible()),
  Click.on(ProxyPage.runtimeStatus),
  Wait.until(ProxyPage.expand, isVisible()),
  Check.whether(ProxyPage.section, not(isVisible())).andIfSo(Click.on(ProxyPage.expand)),
  Wait.until(ProxyPage.section, isVisible()),
  Wait.until(ProxyPage.toggle, isVisible()),
);

export const RememberProxySettings = () => Task.where('#actor verifies the UI against its exact public baseline before editing',
  RememberProxyBaseline(),
  Wait.until(ProxySwitchState(), equals(ProxyBaselineSwitchState())),
  Wait.until(ProxyServer(), equals(ProxyResource().baseline.proxyServer)),
  Wait.until(ProxyBypassRules(), equals(ProxyResource().baseline.proxyBypassRules)),
  Wait.until(ProxySaveIsEnabled(), equals(false)),
);

export const SetProxyEnabled = (enabled: boolean) => Task.where(`#actor ${ enabled ? 'enables' : 'disables' } the proxy`,
  Check.whether(ProxySwitchState(), equals(enabled ? 'unchecked' : 'checked')).andIfSo(Click.on(ProxyPage.toggle)),
  Wait.until(ProxySwitchState(), equals(enabled ? 'checked' : 'unchecked')),
);

export const SetProxyServer = (server: Answerable<string>) => Task.where('#actor enters the proxy server',
  Enter.theValue(server).into(ProxyPage.server),
);

export const EnterOwnedProxy = () => Task.where('#actor enters only its reserved loopback server and UUID bypass marker',
  SetProxyServer(ProxyResource().server),
  Enter.theValue(ProxyResource().bypassRules).into(ProxyPage.bypass),
);

export const SaveProxySettings = (purpose: 'enabled' | 'disabled' | 'restore') => Task.where(`#actor saves ${purpose} proxy settings once and waits for real confirmation`,
  Wait.until(ProxySaveSucceeded(), equals(false)),
  Wait.until(ProxySaveIsEnabled(), equals(true)),
  ArmProxySave(purpose),
  Click.on(ProxyPage.save),
  Wait.upTo(Duration.ofSeconds(45)).until(ProxySaveSucceeded(), equals(true)),
  ConfirmProxySave(),
  Wait.until(ProxySaveLabel(), matches(/^(Save|保存)$/)),
  Wait.until(ProxySaveIsEnabled(), equals(false)),
);

export const ReloadProxySettings = () => Task.where('#actor reloads proxy settings through the real UI and reads canonical persistence',
  Navigate.reloadPage(),
  OpenProxySettings(),
  ReadConfirmedProxySettings(),
);

export const RestoreProxySettings = () => Task.where('#actor restores the exact original proxy fields without overwriting unknown or foreign changes',
  PlanProxyCleanup(),
  Check.whether(ProxyCleanupAction(), equals('none')).andIfSo().otherwise(
    Navigate.reloadPage(),
    OpenProxySettings(),
    Check.whether(ProxyCleanupAction(), equals('restore')).andIfSo(
      Check.whether(ProxyResource().baseline.proxyEnabled, equals(true)).andIfSo(SetProxyEnabled(true)).otherwise(SetProxyEnabled(false)),
      SetProxyServer(ProxyResource().baseline.proxyServer),
      Enter.theValue(ProxyResource().baseline.proxyBypassRules).into(ProxyPage.bypass),
      SaveProxySettings('restore'),
      ReloadProxySettings(),
    ),
    Wait.until(ProxySwitchState(), equals(ProxyBaselineSwitchState())),
    Wait.until(ProxyServer(), equals(ProxyResource().baseline.proxyServer)),
    Wait.until(ProxyBypassRules(), equals(ProxyResource().baseline.proxyBypassRules)),
    Wait.until(ProxySaveIsEnabled(), equals(false)),
    ReadConfirmedProxySettings(),
  ),
);

export const ReleaseProxyEndpoint = () => Task.where('#actor releases its loopback listener independently of UI restoration', CloseProxyEndpoint());
