import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorldViewTaskSetup } from '../../questions/world-views.question.js';
import { LeaveWorldTaskView, PrepareWorldViewTask } from '../../tasks/world-views.task.js';

test('World F setup: register one new zero-effect Task through normal UI and read its original full receipt and complete contract', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      PrepareWorldViewTask(),
      Ensure.that(WorldViewTaskSetup().phase, equals('completed')),
      Ensure.that(WorldViewTaskSetup().fullContractMatched, equals(true)),
      Ensure.that(WorldViewTaskSetup().allowedEffects, equals([])),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try { await actor.attemptsTo(LeaveWorldTaskView()); }
    catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World F Task setup retains its original request, operation identity and contract; no unknown registration is replayed or deleted');
    }
  }
});
