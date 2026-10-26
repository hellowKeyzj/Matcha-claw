import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { OrderEvaluationHasExactCoverage, OrderEvaluationHasExactRegistrations, OrderEvaluationHasOneRun } from '../../questions/world-order-evaluation.question.js';
import {
  FreezeOrderEvaluationSuite, OpenOrderEvaluation, PreserveOrderEvaluation,
  RegisterOrderEvaluationCases, RunOrderEvaluationOnce,
} from '../../tasks/world-order-evaluation.task.js';
import { PrepareWorldOrderExecution, PreserveWorldOrderSetup } from '../../tasks/world-order-setup.task.js';

test('World 订单执行前置：真实 UI 激活独立数学 Oracle、登记新 Task 并验证原 Function/Strategy，不改历史', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(PrepareWorldOrderExecution());
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(PreserveWorldOrderSetup());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Order setup evidence failed; retain the original failure and all durable operation history');
    }
  }
});

test('World 订单用例登记：真实 UI 登记 Train/Holdout 各四例并验证完整原始登记凭据', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenOrderEvaluation(), RegisterOrderEvaluationCases(),
      Ensure.that(OrderEvaluationHasExactRegistrations(), equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(PreserveOrderEvaluation());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Order registration cleanup failed; retain the original failure, exact request custody and all durable history');
    }
  }
});

test('World 订单整数金额：真实 UI 登记 Train/Holdout 各四例、冻结四臂、只评测一次并精确回读原报告', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenOrderEvaluation(), RegisterOrderEvaluationCases(), FreezeOrderEvaluationSuite(), RunOrderEvaluationOnce(),
      Ensure.that(OrderEvaluationHasOneRun(), equals(true)),
      Ensure.that(OrderEvaluationHasExactCoverage(), equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(PreserveOrderEvaluation());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Order evaluation cleanup failed; retain the original failure, exact request custody and all durable history');
    }
  }
});
