import { Ensure, equals } from '@serenity-js/assertions';
import { Check } from '@serenity-js/core';
import { test } from '../../fixtures/serenity.js';
import {
  WorldCompilationIsConfirmed, WorldCompilationNeedsConfirmation, WorldDefinitionPreviewCount,
  WorldSubmitIsEnabled,
} from '../../questions/world-authoring.question.js';
import {
  WorldOrderAmountSemantics, WorldOrderCompileGroupCount, WorldOrderDefinitionPreview,
  WorldOrderOriginalDefinitions, WorldOrderOriginalInput, WorldOrderSelectedFunction, WorldOrderSelectedTask,
  WorldOrderTaskIsExact, WorldOrderTaskIsRecorded, WorldOrderTaskPreviewMatchesOriginal,
  WorldOrderProposal, WorldOrderValidation, WorldOrderStructureMode, WorldOrderStructureResume,
} from '../../questions/world-compilation.question.js';
import {
  CancelWorldOrderTaskSelection, LeaveWorldOrderDraft, LeaveWorldOrderReview, OpenWorldOrderTaskPreview,
  PreviewWorldOrderDefinitions, ProposeOriginalWorldOrderDefinitions, RegisterOriginalWorldOrderTask,
  ReselectWorldOrderCompileDraft, SelectWorldOrderCompileDraft, ValidateOriginalWorldOrderDefinitions,
  PrepareWorldOrderStructureReview, ResumeOriginalWorldOrderStructure,
} from '../../tasks/world-compilation.task.js';

const parameters = ['quantity', 'unitPriceCents'].map(id => ({ id, valueType: { kind: 'integer' }, nullable: false, optional: false }));
const functionRef = { world: { tenantId: 'local', worldId: 'personal' }, id: 'function:order-line-total:20261026:r1', revision: '1' };
const guard = { kind: 'all', terms: [
  ['quantity', 'greater_or_equal', '1'], ['quantity', 'less_or_equal', '1000000'],
  ['unitPriceCents', 'greater_or_equal', '0'], ['unitPriceCents', 'less_or_equal', '1000000000'],
].map(([id, operator, value]) => ({
  kind: 'binary', operator, left: { kind: 'parameter', id }, right: { kind: 'literal', value: { kind: 'integer', value } },
})) };

test('World C 原订单Task正常UI登记及完整契约回读，保留原Oracle pin，零模型零外Source不编译不发布', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenWorldOrderTaskPreview(),
      Ensure.that(WorldOrderTaskPreviewMatchesOriginal(), equals(true)),
      RegisterOriginalWorldOrderTask(),
      Ensure.that(WorldOrderTaskIsRecorded(), equals(true)),
      Ensure.that(WorldOrderTaskIsExact(), equals(true)),
      Ensure.that(WorldDefinitionPreviewCount(), equals(0)),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldOrderDraft());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World order Task UI cleanup failed; original registration failure and unknown request are retained without replay');
    }
  }
});

test('World C 原r1订单Function与Strategy非空提案结构验证或显式只读回放，同branch validated，保留Oracle pin，不执行Schema或Task不发布', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      PrepareWorldOrderStructureReview(),
      Check.whether(WorldOrderStructureMode(), equals('resume')).andIfSo(
        ResumeOriginalWorldOrderStructure(),
        Ensure.that(WorldOrderStructureResume().verification, equals('persisted-structure-only')),
        Ensure.that(WorldOrderStructureResume().operationReceiptsRechecked, equals(false)),
        Ensure.that(WorldOrderStructureResume().candidateRechecked, equals(false)),
        Ensure.that(WorldOrderStructureResume().change.id, equals(WorldOrderStructureResume().record.changeId)),
        Ensure.that(WorldOrderStructureResume().branch.id, equals(WorldOrderStructureResume().record.branchId)),
        Ensure.that(WorldOrderStructureResume().change.status, equals('validated')),
        Ensure.that(WorldOrderStructureResume().change.revision, equals('2')),
        Ensure.that(WorldOrderStructureResume().exactDefinitions, equals(true)),
        Ensure.that(WorldOrderStructureResume().exactTask, equals(true)),
        Ensure.that(WorldOrderStructureResume().activeReleaseUnchanged, equals(true)),
      ).otherwise(
        Ensure.that(WorldOrderStructureMode(), equals('submit')),
        OpenWorldOrderTaskPreview(),
        Ensure.that(WorldOrderTaskPreviewMatchesOriginal(), equals(true)),
        RegisterOriginalWorldOrderTask(),
        ProposeOriginalWorldOrderDefinitions(),
        Ensure.that(WorldOrderProposal().status, equals('proposed')),
        Ensure.that(WorldOrderProposal().revision, equals('1')),
        Ensure.that(WorldOrderProposal().phase, equals('completed')),
        Ensure.that(WorldOrderProposal().resultKind, equals('candidate')),
        Ensure.that(WorldOrderProposal().effects, equals([])),
        Ensure.that(WorldOrderProposal().modelCalls, equals([])),
        Ensure.that(WorldOrderProposal().sourceBasis, equals([])),
        Ensure.that(WorldOrderProposal().exactDefinitions, equals(true)),
        ValidateOriginalWorldOrderDefinitions(),
        Ensure.that(WorldOrderValidation().id, equals(WorldOrderProposal().id)),
        Ensure.that(WorldOrderValidation().branchId, equals(WorldOrderProposal().branchId)),
        Ensure.that(WorldOrderValidation().status, equals('validated')),
        Ensure.that(WorldOrderValidation().revision, equals('2')),
        Ensure.that(WorldOrderValidation().phase, equals('completed')),
        Ensure.that(WorldOrderValidation().resultKind, equals('candidate')),
        Ensure.that(WorldOrderValidation().effects, equals([])),
        Ensure.that(WorldOrderValidation().modelCalls, equals([])),
        Ensure.that(WorldOrderValidation().sourceBasis, equals([])),
        Ensure.that(WorldOrderValidation().exactDefinitions, equals(true)),
        Ensure.that(WorldOrderValidation().activeReleaseUnchanged, equals(true)),
      ),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldOrderReview());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World order structural review cleanup failed; preserve the original receipt and unknown UI request without replay');
    }
  }
});

test('World 订单作者输入预览与编译选择草稿，不执行编译/送审', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenWorldOrderTaskPreview(),
      Ensure.that(WorldOrderTaskPreviewMatchesOriginal(), equals(true)),
      Ensure.that(WorldOrderOriginalInput(), equals({ kind: 'record', fields: {
        quantity: { kind: 'integer', value: '3' }, unitPriceCents: { kind: 'integer', value: '1999' },
      } })),
      PreviewWorldOrderDefinitions(),
      Ensure.that(WorldOrderDefinitionPreview(), equals(WorldOrderOriginalDefinitions())),
      Ensure.that(WorldOrderAmountSemantics(), equals({
        count: 2, functionParameters: parameters, resultType: { kind: 'integer' },
        expression: { kind: 'binary', operator: 'multiply', left: { kind: 'parameter', id: 'quantity' }, right: { kind: 'parameter', id: 'unitPriceCents' } },
        strategyParameters: parameters, strategyGuard: guard,
        strategySteps: [{ id: 'calculate-line-total', dependsOn: [], guard, operation: {
          kind: 'function', function: functionRef,
          arguments: [{ kind: 'parameter', id: 'quantity' }, { kind: 'parameter', id: 'unitPriceCents' }],
        } }],
        strategyDependencies: [functionRef],
      })),
      Ensure.that(WorldOrderSelectedTask(), equals('')),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
      SelectWorldOrderCompileDraft(),
      Ensure.that(WorldOrderSelectedFunction(), equals('function:order-line-total:20261026:r1:1')),
      Ensure.that(WorldCompilationIsConfirmed(), equals(true)),
      CancelWorldOrderTaskSelection(),
      Ensure.that(WorldOrderSelectedTask(), equals('')),
      Ensure.that(WorldOrderCompileGroupCount(), equals(0)),
      Ensure.that(WorldDefinitionPreviewCount(), equals(1)),
      Ensure.that(WorldOrderDefinitionPreview(), equals(WorldOrderOriginalDefinitions())),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
      ReselectWorldOrderCompileDraft(),
      Ensure.that(WorldCompilationNeedsConfirmation(), equals(true)),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldOrderDraft());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World order-authoring draft cleanup failed; the original failure is retained and no mutation is replayed');
    }
  }
});
