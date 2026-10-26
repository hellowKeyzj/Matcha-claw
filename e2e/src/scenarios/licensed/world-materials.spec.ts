import { Ensure, equals, isGreaterThan } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  WorldMaterialsDraft, WorldMaterialsOperation, WorldMaterialsParsed, WorldMaterialsRefresh, WorldMaterialsRejection,
  WorldMaterialsRejectionRefresh, WorldMaterialsUpload,
} from '../../questions/world-materials.question.js';
import {
  ImportOriginalWorldMaterial, ReadOriginalWorldMaterialInUi, RefreshWorldMaterialAndRead, RefreshWorldMaterialRejection,
  RejectZeroModelWorldMaterial, VerifyWorldMaterialProcessing,
} from '../../tasks/world-materials.task.js';
import { LeaveWorldWorkspace, OpenExistingWorldWorkspace, OpenWorldWorkspace } from '../../tasks/world-workspace.task.js';

test('World A 原93B文字资料经UI上传、真实Generation/Extraction与定位对齐，持久候选及原版本依据刷新回读；1次模型0外Source不发布', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenWorldWorkspace(), ImportOriginalWorldMaterial(),
      Ensure.that(WorldMaterialsUpload().sealed, equals(true)), Ensure.that(WorldMaterialsUpload().byteSize, equals('93')),
      VerifyWorldMaterialProcessing(),
      Ensure.that(WorldMaterialsOperation().phase, equals('completed')),
      Ensure.that(WorldMaterialsOperation().sourceCount, equals(1)), Ensure.that(WorldMaterialsOperation().artifactCount, equals(1)),
      Ensure.that(WorldMaterialsOperation().draftCount, equals(1)),
      Ensure.that(WorldMaterialsParsed().exactOriginal, equals(true)), Ensure.that(WorldMaterialsParsed().covered, equals(true)),
      Ensure.that(WorldMaterialsDraft().candidates, isGreaterThan(0)), Ensure.that(WorldMaterialsDraft().modelCalls, equals(1)),
      Ensure.that(WorldMaterialsDraft().evidence, isGreaterThan(0)), Ensure.that(WorldMaterialsDraft().coverage, isGreaterThan(0)),
      Ensure.that(WorldMaterialsDraft().readNeeds, equals(0)), Ensure.that(WorldMaterialsDraft().activeReleaseUnchanged, equals(true)),
      ReadOriginalWorldMaterialInUi(), RefreshWorldMaterialAndRead(),
      Ensure.that(WorldMaterialsRefresh(), equals({ exact: true, activeReleaseUnchanged: true })),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldWorkspace());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World materials UI cleanup failed; original failure and all unresolved upload/operation/draft identities are retained, never resubmitted or deleted');
    }
  }
});

test('World Materials 零模型预算上传业务拒绝：同次world/requestId/完整Failure刷新保留，sealed字节匹配且原Task与全目录不变', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenExistingWorldWorkspace(), RejectZeroModelWorldMaterial(),
      Ensure.that(WorldMaterialsRejection().world, equals({ tenantId: 'local', worldId: 'personal' })),
      Ensure.that(WorldMaterialsRejection().outcome, equals('business_input_invalid')),
      Ensure.that(WorldMaterialsRejection().failure.details, equals({ kind: 'operation', failure: { kind: 'material', failure: { kind: 'input_invalid' } } })),
      Ensure.that(WorldMaterialsRejection().sealed, equals(true)), Ensure.that(WorldMaterialsRejection().operationAccepted, equals(false)),
      Ensure.that(WorldMaterialsRejection().taskUnchanged, equals(true)), Ensure.that(WorldMaterialsRejection().activeReleaseUnchanged, equals(true)),
      Ensure.that(WorldMaterialsRejection().catalogUnchanged, equals(true)),
      RefreshWorldMaterialRejection(), Ensure.that(WorldMaterialsRejectionRefresh(), equals(WorldMaterialsRejection())),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldWorkspace());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World materials rejection cleanup failed; primary failure and append-only single-attempt custody are preserved without resend or deletion');
    }
  }
});
