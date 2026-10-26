import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { ProviderRoutingPrimaryMatchesPublicFacts, ProviderRoutingReply } from '../../questions/provider-routing.question.js';
import {
  CompareProviderRoutingUi, ReadPublicProviderRouting, RequestInvalidProviderRouting,
  RequestUnknownProviderRoutingCapability, RestoreProviderRoutingPanel,
} from '../../tasks/provider-routing.task.js';

test('Provider Routing API 边界返回脱敏 list，模型分配页只读显示对应主模型', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      ReadPublicProviderRouting(),
      Ensure.that(ProviderRoutingReply(), equals({
        ipcSucceeded: true, matchesStatus: true, matchesPublicBody: true, publicProjectionSafe: true,
      })),
      CompareProviderRoutingUi(),
      Ensure.that(ProviderRoutingPrimaryMatchesPublicFacts(), equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(RestoreProviderRoutingPanel());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'The routing panel disclosure state could not be restored; the original failure is retained');
    }
  }
});

test('Provider Routing API 边界以 400 拒绝携私密附加字段的 list 且不回显输入', async ({ actor }) => {
  await actor.attemptsTo(
    RequestInvalidProviderRouting(),
    Ensure.that(ProviderRoutingReply(), equals({
      ipcSucceeded: true, matchesStatus: true, matchesPublicBody: true, publicProjectionSafe: true,
    })),
  );
});

test('Provider Routing API 边界以 404 拒绝未知 capability 且不泄露私密输入', async ({ actor }) => {
  await actor.attemptsTo(
    RequestUnknownProviderRoutingCapability(),
    Ensure.that(ProviderRoutingReply(), equals({
      ipcSucceeded: true, matchesStatus: true, matchesPublicBody: true, publicProjectionSafe: true,
    })),
  );
});
