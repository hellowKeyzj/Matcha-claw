import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorldActionCompletedOnce, WorldActionIdentityMatchesOriginal } from '../../questions/world-actions.question.js';
import {
  ApproveBoundWorldAction, ExecuteBoundWorldActionOnce, OpenBoundWorldAction,
  PreserveBoundWorldAction, ProposeAndReviewBoundWorldAction,
} from '../../tasks/world-actions.task.js';

test('World D: bound real action → in-app approval → one submission → same receipt and independent Verifier', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenBoundWorldAction(), ProposeAndReviewBoundWorldAction(), ApproveBoundWorldAction(), ExecuteBoundWorldActionOnce(),
      Ensure.that(WorldActionCompletedOnce(), equals(true)),
      Ensure.that(WorldActionIdentityMatchesOriginal(), equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try { await actor.attemptsTo(PreserveBoundWorldAction()); }
    catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World D retains the primary failure, cleanup failure, original request custody and durable history; no automatic resend or recovery');
    }
  }
});
