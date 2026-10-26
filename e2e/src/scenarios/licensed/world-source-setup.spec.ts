import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorldSourceSetupEvidence } from '../../questions/world-sources.question.js';
import { LeaveWorldSources, SetUpWorldSourceConnections } from '../../tasks/world-sources.task.js';

test('World Source 正常 UI 创建两条本地只读 HTTP 连接并精确回读原回执，不把配置冒充发现、同步或发布', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      SetUpWorldSourceConnections(),
      Ensure.that(WorldSourceSetupEvidence().phase, equals('connections-confirmed')),
      Ensure.that(WorldSourceSetupEvidence().confirmed, equals(2)),
      Ensure.that(WorldSourceSetupEvidence().changedRelease, equals(false)),
      Ensure.that(WorldSourceSetupEvidence().synchronized, equals(false)),
    );
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await actor.attemptsTo(LeaveWorldSources()); }
    catch (cleanupFailure) { throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure], 'Source setup original failure and cleanup retained without mutation replay'); }
  }
});
