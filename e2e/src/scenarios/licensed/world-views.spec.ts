import { Ensure, equals, isGreaterThan } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorldViewsFacts, WorldViewsOriginals, WorldViewsResolution, WorldViewsUnknownCount } from '../../questions/world-views.question.js';
import { BuildWorldTaskView, LeaveWorldTaskView, ResolveWorldTaskToGuardStop } from '../../tasks/world-views.task.js';

test('World F 原证据与真实对象/Strategy组成同Task WorldView，保留known/unknown及同次读取回执，不把声明当Verified', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      BuildWorldTaskView('view'),
      Ensure.that(WorldViewsFacts().rawEvidenceBound, equals(true)), Ensure.that(WorldViewsFacts().exactFacts, equals(true)),
      Ensure.that(WorldViewsUnknownCount(), isGreaterThan(0)), Ensure.that(WorldViewsFacts().guardVerdict, equals('not-yet-observed')),
      Ensure.that(WorldViewsOriginals(), equals({ originalTaskUnchanged: true, originalAbstractionUnchanged: true, activeReleaseUnchanged: true })),
    );
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await actor.attemptsTo(LeaveWorldTaskView()); }
    catch (cleanupFailure) { throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure], 'World F view cleanup failed; preserve the original evidence and error'); }
  }
});

test('World F 同原Task真实ResolveTask回执证明guard=false时stop，不执行fallback扩展或模型/Source，不改Oracle pin', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      BuildWorldTaskView('false'), ResolveWorldTaskToGuardStop(),
      Ensure.that(WorldViewsResolution().phase, equals('completed')), Ensure.that(WorldViewsResolution().guard, equals('false')),
      Ensure.that(WorldViewsResolution().fallback, equals('stop')), Ensure.that(WorldViewsResolution().verified, equals(false)),
      Ensure.that(WorldViewsResolution().originalTaskUnchanged, equals(true)), Ensure.that(WorldViewsResolution().effects, equals([])),
    );
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await actor.attemptsTo(LeaveWorldTaskView()); }
    catch (cleanupFailure) { throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure], 'World F guard=false cleanup failed; retain the same operation without replay'); }
  }
});

test('World F 同原Task真实unknown事实与guard=unknown回执触发stop，inconclusive不冒成功且unknown mutation不重发', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      BuildWorldTaskView('unknown'), Ensure.that(WorldViewsUnknownCount(), isGreaterThan(0)), ResolveWorldTaskToGuardStop(),
      Ensure.that(WorldViewsResolution().phase, equals('completed')), Ensure.that(WorldViewsResolution().guard, equals('unknown')),
      Ensure.that(WorldViewsResolution().outcome, equals({ kind: 'inconclusive', reason: { kind: 'guard_not_satisfied', field: ['abstraction', 'guard'], truth: 'unknown' } })),
      Ensure.that(WorldViewsResolution().fallback, equals('stop')), Ensure.that(WorldViewsResolution().verified, equals(false)),
      Ensure.that(WorldViewsResolution().originalTaskUnchanged, equals(true)), Ensure.that(WorldViewsResolution().effects, equals([])),
    );
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await actor.attemptsTo(LeaveWorldTaskView()); }
    catch (cleanupFailure) { throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure], 'World F guard=unknown cleanup failed; only the original receipt may be inspected'); }
  }
});
