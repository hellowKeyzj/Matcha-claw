import { test } from '../../fixtures/serenity.js';
import { ConnectDedicatedWorldStorage } from '../../tasks/world-storage.task.js';
import { InspectCurrentWorldPrerequisites, LeaveWorldWorkspace, OpenExistingWorldWorkspace } from '../../tasks/world-workspace.task.js';

// A connection update is independent of a backup attempt and never replays one.
test('World 专用数据库连接：正常私密表单连接同一已有库，选择本次可访问 World 并核对完整业务目录', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      ConnectDedicatedWorldStorage(), OpenExistingWorldWorkspace(), InspectCurrentWorldPrerequisites(),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); }
    catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World storage connection and UI cleanup failures retained; no backup was submitted');
    }
  }
});
