import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorldStorageReady, WorldStorageRepeated } from '../../questions/world-storage.question.js';
import { EnableOrRestoreWorldStorage, OpenWorldStorage, ReconnectWorldStorage } from '../../tasks/world-storage.task.js';
import { LeaveWorldWorkspace } from '../../tasks/world-workspace.task.js';

const catalogs = ['definitions', 'materials', 'connections', 'action_proposals', 'changes', 'evaluations'];

test('World 存储幂等启用：独立运行如实记录 fresh 或 restored，自动恢复无需输入，六目录可读且重复连接不改完整授权', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      OpenWorldStorage(), EnableOrRestoreWorldStorage(),
      Ensure.that(WorldStorageReady().canonicalReady, equals(true)),
      Ensure.that(WorldStorageReady().authorizationUnchanged, equals(true)),
      Ensure.that(WorldStorageReady().catalogs, equals(catalogs)),
      ReconnectWorldStorage(),
      Ensure.that(WorldStorageRepeated(), equals({
        sameWorld: true, sameStorage: true, sameRelease: true, authorizationUnchanged: true, catalogs, journalCleared: true,
      })),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'World storage verification and UI restoration failed; all failures retained');
});
