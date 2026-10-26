import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorldEvaluationEvidence } from '../../questions/world-evaluation.question.js';
import {
  CheckWorldEvaluationCancellation, OpenWorldEvaluation, PreserveWorldEvaluation,
  ReturnToSavedWorldEvaluation, SaveWorldEvaluationOnce,
} from '../../tasks/world-evaluation.task.js';

test('World 独立评测原生选文件后八项摘要 exact，应用内确认取消不写；已配置仅回读同原提交', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenWorldEvaluation(), CheckWorldEvaluationCancellation(),
      Ensure.that(WorldEvaluationEvidence().submissionAttempts, equals(0)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(PreserveWorldEvaluation());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Evaluation cancellation cleanup failed; preserve the original failure and approved input');
    }
  }
});

test('World 独立评测同原件取消后重选、一次应用内确认、公开状态 exact、离页返回不重首配；已配置只读回放', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenWorldEvaluation(), SaveWorldEvaluationOnce(), ReturnToSavedWorldEvaluation(),
      Ensure.that(WorldEvaluationEvidence().phase, equals('returned')),
      Ensure.that(WorldEvaluationEvidence().status, equals({
        outcome: 'available', world: { tenantId: 'local', worldId: 'personal' }, configured: true,
        commitId: 'commit:eval-admin-ready-20261026-4e92d6a1',
      })),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(PreserveWorldEvaluation());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Evaluation installation cleanup failed; retain the exact original commit and never replay an unresolved submission');
    }
  }
});
