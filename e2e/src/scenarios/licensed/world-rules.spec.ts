import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorldRuleChain, WorldRuleReceipt } from '../../questions/world-rules.question.js';
import {
  EvaluateWorldRule, LeaveWorldRules, PrepareWorldRules, ReleaseWorldRules, VerifyWorldRuleChain,
} from '../../tasks/world-rules.task.js';

test('World P→Q→R 真实规则UI两级推导、精确branch及双时间/原Source完整Explain回读，unknown保持pending而非false，零模型', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      PrepareWorldRules(),
      EvaluateWorldRule('q'), Ensure.that(WorldRuleReceipt().result.result.status, equals('valid')),
      EvaluateWorldRule('r'), Ensure.that(WorldRuleReceipt().result.result.status, equals('valid')),
      EvaluateWorldRule('unknown'),
      Ensure.that(WorldRuleReceipt().result.result, equals({ status: 'pending', assertion: null })),
      VerifyWorldRuleChain(),
      Ensure.that(WorldRuleChain().chainVerified, equals(true)),
      Ensure.that(WorldRuleChain().recordedReplayVerified, equals(true)),
      Ensure.that(WorldRuleChain().unknownRemainsUnknown, equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try { await actor.attemptsTo(ReleaseWorldRules()); } catch (error) { cleanupFailures.push(error); }
    try { await actor.attemptsTo(LeaveWorldRules()); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) throw new AggregateError(primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
      'World PQR cleanup failed; original failure and any original unknown request are retained, never replayed/resumed/cancelled; no durable facts or history removed');
  }
});
