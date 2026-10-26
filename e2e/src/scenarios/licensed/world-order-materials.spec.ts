import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorldMaterialsDraft, WorldMaterialsOperation, WorldMaterialsParsed, WorldOrderMaterialSource, WorldOrderUploadReadback } from '../../questions/world-materials.question.js';
import { OrderFourArmExecutionGrantsConfirmed, OrderMaterialsExecutionGrantConfirmed } from '../../questions/world-order-evaluation.question.js';
import { AuthorizeWorldOrderChangeSetExecution, AuthorizeWorldOrderFourArmExecution, AuthorizeWorldOrderMaterialsExecution } from '../../tasks/world-order-setup.task.js';
import { OrderChangeSetGrantConfirmed } from '../../questions/world-order-access.question.js';
import { ImportOriginalWorldMaterial, ReadExactOrderMaterial, ReadRetainedWorldOrderUpload, VerifyWorldMaterialProcessing } from '../../tasks/world-materials.task.js';
import { LeaveWorldWorkspace, OpenExistingWorldWorkspace } from '../../tasks/world-workspace.task.js';

test('World 订单原43B JSON经UI单次Import、真实parse与Generation/extraction，公开唯一exactSourceVersion供订单评测使用', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenExistingWorldWorkspace(), ImportOriginalWorldMaterial('order'), VerifyWorldMaterialProcessing(),
      Ensure.that(WorldMaterialsOperation().phase, equals('completed')),
      Ensure.that(WorldMaterialsOperation().sourceCount, equals(1)), Ensure.that(WorldMaterialsOperation().artifactCount, equals(1)),
      Ensure.that(WorldMaterialsOperation().draftCount, equals(1)),
      Ensure.that(WorldMaterialsParsed().exactOriginal, equals(true)), Ensure.that(WorldMaterialsParsed().covered, equals(true)),
      Ensure.that(WorldMaterialsDraft().readNeeds, equals(0)), Ensure.that(WorldMaterialsDraft().activeReleaseUnchanged, equals(true)),
      ReadExactOrderMaterial(),
      Ensure.that(WorldOrderMaterialSource().complete, equals(true)), Ensure.that(WorldOrderMaterialSource().catalogMatches, equals(1)),
      Ensure.that(WorldOrderMaterialSource().byteSize, equals('43')),
      Ensure.that(WorldOrderMaterialSource().digest, equals('sha256:296608598081023969767712633ae0c06e9ffea3670f1803e108db3f767992da')),
      Ensure.that(WorldOrderMaterialSource().exactSourceVersion.world, equals({ tenantId: 'local', worldId: 'personal' })),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldWorkspace());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Order materials cleanup failed; original import custody and primary failure are retained without replay or deletion');
    }
  }
});

test('World 原订单上传只读恢复：精确43B封存回执，不重发Import且不把封存当业务完成', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenExistingWorldWorkspace(), ReadRetainedWorldOrderUpload(),
      Ensure.that(WorldOrderUploadReadback().sealed, equals(true)),
      Ensure.that(WorldOrderUploadReadback().byteSize, equals('43')),
      Ensure.that(WorldOrderUploadReadback().digest, equals('sha256:296608598081023969767712633ae0c06e9ffea3670f1803e108db3f767992da')),
      Ensure.that(WorldOrderUploadReadback().importAcceptanceProved, equals(false)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldWorkspace());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Original upload readback cleanup failed; retain the primary failure without any upload, import or retry');
    }
  }
});

test('World 订单材料有限执行授权：仅exact Source读写执行及probabilistic，双确认原授权回执，不上传或Import', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenExistingWorldWorkspace(), AuthorizeWorldOrderMaterialsExecution(),
      Ensure.that(OrderMaterialsExecutionGrantConfirmed(), equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldWorkspace());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Materials execution grant cleanup failed; retain the original grant custody and primary failure without upload, Import or resend');
    }
  }
});

test('World 订单四臂有限执行授权：公开核实已知exact资源，Service与桌面各双确认；不执行评测、不授未来报告或虚构Source', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenExistingWorldWorkspace(), AuthorizeWorldOrderFourArmExecution(),
      Ensure.that(OrderFourArmExecutionGrantsConfirmed(), equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldWorkspace());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Four-arm grant cleanup failed; retain both original grant custodies and primary failure without upload, evaluation or resend');
    }
  }
});

test('World 原变更有限授权：原操作证明exact变更，只授桌面Human读写并公开重读原回执，不执行评测', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenExistingWorldWorkspace(), AuthorizeWorldOrderChangeSetExecution(),
      Ensure.that(OrderChangeSetGrantConfirmed(), equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldWorkspace());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'ChangeSet grant cleanup failed; retain the original grant custody and primary failure without proposal, evaluation or resend');
    }
  }
});
