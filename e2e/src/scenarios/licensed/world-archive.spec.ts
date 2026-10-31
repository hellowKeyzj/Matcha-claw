import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  WorldBackupDownload, WorldBackupKey, WorldBackupReadback, WorldBackupReadbackIsComplete, WorldBackupReceipt,
} from '../../questions/world-archive.question.js';
import { CurrentWorldPrerequisites } from '../../questions/world-workspace.question.js';
import { CreateWorldBackup, RefreshWorldBackupReadback, VerifyWorldBackupPreservedBusiness } from '../../tasks/world-archive.task.js';
import { InspectCurrentWorldPrerequisites, LeaveWorldWorkspace, OpenExistingWorldWorkspace } from '../../tasks/world-workspace.task.js';

test('World 默认备份一次：完整原回执与真实下载一致，刷新回读同key及manifest，六目录与包信任不变；不restore/delete', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenExistingWorldWorkspace(), InspectCurrentWorldPrerequisites(),
      Ensure.that(CurrentWorldPrerequisites().unchanged, equals(true)),
      CreateWorldBackup(),
      Ensure.that(WorldBackupReceipt().phase, equals('completed')),
      Ensure.that(WorldBackupReceipt().disclosure.kind, equals('full')),
      Ensure.that(WorldBackupReceipt().failure, equals(null)),
      Ensure.that(WorldBackupReceipt().effects, equals([])),
      Ensure.that(WorldBackupReceipt().result.kind, equals('backup')),
      Ensure.that(WorldBackupReceipt().accepted.world, equals(WorldBackupKey().world)),
      Ensure.that(WorldBackupReceipt().accepted.operationId, equals(WorldBackupKey().operationId)),
      Ensure.that(WorldBackupDownload().equalsReceipt, equals(true)),
      RefreshWorldBackupReadback(), InspectCurrentWorldPrerequisites(), VerifyWorldBackupPreservedBusiness(),
      Ensure.that(CurrentWorldPrerequisites().unchanged, equals(true)),
      Ensure.that(WorldBackupReadback().unchanged, equals(true)),
      Ensure.that(WorldBackupReadback().operationKey, equals(WorldBackupKey())),
      Ensure.that(WorldBackupReadback().manifest, equals(WorldBackupReceipt().result.result.manifest)),
      Ensure.that(WorldBackupReadbackIsComplete(), equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); }
    catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World backup UI cleanup failed; preserve the original attempt, OperationKey, receipt and cleanup failures without replay');
    }
  }
});
