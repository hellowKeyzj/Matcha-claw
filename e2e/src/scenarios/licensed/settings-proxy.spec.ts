import { Ensure, equals } from '@serenity-js/assertions';
import { Duration } from '@serenity-js/core';
import { test } from '../../fixtures/serenity.js';
import {
  ProxyBypassRules, ProxyPublicSettingsMatch, ProxyResource, ProxySaveIsEnabled, ProxySaveReceipt,
  ProxyServer, ProxySettingsIsVisible, ProxySwitchIsVisible, ProxySwitchState,
} from '../../questions/proxy.question.js';
import { EnterChat } from '../../tasks/chat.task.js';
import {
  EnterOwnedProxy, OpenProxySettings, ReleaseProxyEndpoint, ReloadProxySettings, RememberProxySettings,
  RestoreProxySettings, SaveProxySettings, SetProxyEnabled,
} from '../../tasks/proxy.task.js';

const confirmed = { status: 'succeeded', outcome: 'confirmed', exactPublicSettings: true };

test('代理启用和禁用都经真实保存，跨刷新精确保留输入并恢复原六字段基线', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      OpenProxySettings(),
      Ensure.that(ProxySettingsIsVisible(), equals(true)),
      Ensure.that(ProxySwitchIsVisible(), equals(true)),
      RememberProxySettings(),
      SetProxyEnabled(true),
      EnterOwnedProxy(),
      Ensure.eventually(ProxySaveIsEnabled(), equals(true)),
      SaveProxySettings('enabled'),
      Ensure.that(ProxySaveReceipt(), equals(confirmed)),
      ReloadProxySettings(),
      Ensure.eventually(ProxyServer(), equals(ProxyResource().server)).timeoutAfter(Duration.ofSeconds(45)),
      Ensure.that(ProxyBypassRules(), equals(ProxyResource().bypassRules)),
      Ensure.that(ProxySwitchState(), equals('checked')),
      Ensure.that(ProxyPublicSettingsMatch(), equals(true)),
      SetProxyEnabled(false),
      Ensure.eventually(ProxySaveIsEnabled(), equals(true)),
      SaveProxySettings('disabled'),
      Ensure.that(ProxySaveReceipt(), equals(confirmed)),
      ReloadProxySettings(),
      Ensure.eventually(ProxyServer(), equals(ProxyResource().server)).timeoutAfter(Duration.ofSeconds(45)),
      Ensure.that(ProxyBypassRules(), equals(ProxyResource().bypassRules)),
      Ensure.that(ProxySwitchState(), equals('unchecked')),
      Ensure.that(ProxySaveIsEnabled(), equals(false)),
      Ensure.that(ProxyPublicSettingsMatch(), equals(true)),
    );
  } catch (error) { failures.push(error); }
  finally {
    for (const restore of [RestoreProxySettings(), EnterChat(), ReleaseProxyEndpoint()]) {
      try { await actor.attemptsTo(restore); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Proxy settings failed; cleanup errors retain the original failure');
});
