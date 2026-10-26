import { Ensure, equals, isGreaterThan } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  WorldSourcesDiscovery, WorldSourcesInput, WorldSourcesPrerequisites, WorldSourcesQuery, WorldSourcesSynchronization,
} from '../../questions/world-sources.question.js';
import {
  DiscoverOriginalWorldSourceSchema, LeaveWorldSources, OpenApprovedWorldSource, QueryOriginalWorldSources,
  SynchronizeOriginalWorldSource,
} from '../../tasks/world-sources.task.js';

test('World B 合法原Source连接探测、真实单次同步及混合查询，同Operation检查点与同次cursor/snapshot/读取回执精确回读；缺真实输入或许可明确失败', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenApprovedWorldSource(),
      Ensure.that(WorldSourcesInput().permissions, equals({ sourceReadApproved: true, schemaDiscoveryApproved: true, synchronizationApproved: true })),
      Ensure.that(WorldSourcesPrerequisites().connectionExact, equals(true)),
      Ensure.that(WorldSourcesPrerequisites().mappingExact, equals(true)),
      Ensure.that(WorldSourcesPrerequisites().capabilitiesProbed, equals(true)),
      Ensure.that(WorldSourcesInput().sourceCount, isGreaterThan(1)),
      DiscoverOriginalWorldSourceSchema(),
      Ensure.that(WorldSourcesDiscovery().phase, equals('completed')),
      Ensure.that(WorldSourcesDiscovery().resultKind, equals('schema')),
      Ensure.that(WorldSourcesDiscovery().exactReadback, equals(true)),
      SynchronizeOriginalWorldSource(),
      Ensure.that(WorldSourcesSynchronization().phase, equals('completed')),
      Ensure.that(WorldSourcesSynchronization().resultKind, equals('sync')),
      Ensure.that(WorldSourcesSynchronization().exactReadback, equals(true)),
      QueryOriginalWorldSources(),
      Ensure.that(WorldSourcesQuery().queryExact, equals(true)),
      Ensure.that(WorldSourcesQuery().sourceCount, equals(WorldSourcesInput().sourceCount)),
      Ensure.that(WorldSourcesQuery().sameSnapshotBasis, equals(true)),
      Ensure.that(WorldSourcesQuery().uiRawRowsVerified, equals(false)),
      Ensure.that(WorldSourcesQuery().uiRawEvidenceVerified, equals(false)),
      Ensure.that(WorldSourcesQuery().afterRawPageVerified, equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldSources());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World B cleanup failed; original prerequisite/business failure and unknown mutation receipt are retained without replay or rollback');
    }
  }
});
