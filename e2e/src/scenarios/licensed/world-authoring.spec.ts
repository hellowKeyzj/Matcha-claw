import { Ensure, equals, includes, not } from '@serenity-js/assertions';
import { Check } from '@serenity-js/core';
import { test } from '../../fixtures/serenity.js';
import {
  WorldCompilationNeedsConfirmation, WorldDefinitionFileIsAvailable, WorldDefinitionPreview,
  WorldDefinitionPreviewCount, WorldDefinitionPreviewSummary, WorldImportedFunctionOptionCount,
  WorldSelectedFunction, WorldSubmitIsEnabled, WorldNoOpChangeId, WorldNoOpReadback, WorldNoOpVisibleId,
  WorldNoOpInitial, WorldNoOpValidation, WorldNoOpRefresh,
} from '../../questions/world-authoring.question.js';
import {
  ChooseExistingWorldTask, ChooseImportedWorldFunction, ConfirmWorldBaselineCompilation, ImportWorldDefinition,
  InspectWorldFunctionChoices, LeaveWorldAuthoring, OpenWorldAuthoring, RemoveWorldDefinition,
  PrepareWorldNoOp, SubmitWorldNoOp, ValidateWorldNoOp, RefreshWorldNoOp,
} from '../../tasks/world-authoring.task.js';

test('World 手工导入在真实 ready 世界预览、换批并移除 Function，不依赖 Task、不提交业务命令', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenWorldAuthoring(),
      Ensure.that(WorldDefinitionFileIsAvailable(), equals(true)),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
      ImportWorldDefinition('first'),
      Ensure.that(WorldDefinitionPreviewSummary(), includes('world-first.json')),
      Ensure.that(WorldDefinitionPreview(), includes('function:e2e-authoring:first')),
      Ensure.that(WorldDefinitionPreview(), not(includes('function:e2e-authoring:replacement'))),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
      ImportWorldDefinition('replacement'),
      Ensure.that(WorldDefinitionPreviewSummary(), includes('world-replacement.json')),
      Ensure.that(WorldDefinitionPreview(), includes('function:e2e-authoring:replacement')),
      Ensure.that(WorldDefinitionPreview(), not(includes('function:e2e-authoring:first'))),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
      RemoveWorldDefinition(),
      Ensure.that(WorldDefinitionPreviewCount(), equals(0)),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldAuthoring());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World import cleanup failed; the original failure is retained');
    }
  }
});

test('World 原 Task 下同一 NoOp 精确续接：proposed 单次 UI Validate、validated 只读回放，刷新不发布；显式新提案须自动导航', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenWorldAuthoring(), PrepareWorldNoOp(), SubmitWorldNoOp(),
      Ensure.that(WorldNoOpInitial().exact, equals(true)),
      Ensure.that(WorldNoOpInitial().activeReleaseUnchanged, equals(true)),
      Ensure.that(WorldNoOpInitial().validationAttempts, equals(0)),
      Check.whether(WorldNoOpInitial().status, equals('proposed')).andIfSo(
        Ensure.that(WorldNoOpInitial().revision, equals('1')),
        Ensure.that(WorldNoOpInitial().phase, includes('proposed')),
      ).otherwise(
        Ensure.that(WorldNoOpInitial().status, equals('validated')),
        Ensure.that(WorldNoOpInitial().revision, equals('2')),
        Ensure.that(WorldNoOpInitial().phase, equals('initial-validated-exact')),
      ),
      ValidateWorldNoOp(),
      Check.whether(WorldNoOpInitial().status, equals('proposed')).andIfSo(
        Ensure.that(WorldNoOpValidation().phase, equals('validation-confirmed')),
        Ensure.that(WorldNoOpValidation().validationAttempts, equals(1)),
      ).otherwise(
        Ensure.that(WorldNoOpValidation().phase, equals('validated-read-only-replay')),
        Ensure.that(WorldNoOpValidation().validationAttempts, equals(0)),
      ),
      Ensure.that(WorldNoOpValidation().id, equals(WorldNoOpInitial().id)),
      Ensure.that(WorldNoOpReadback().revision, equals('2')),
      Ensure.that(WorldNoOpReadback().status, equals('validated')),
      RefreshWorldNoOp(),
      Ensure.that(WorldNoOpRefresh().phase, equals('refresh-confirmed')),
      Ensure.that(WorldNoOpRefresh().id, equals(WorldNoOpInitial().id)),
      Ensure.that(WorldNoOpRefresh().revision, equals('2')),
      Ensure.that(WorldNoOpRefresh().validationAttempts, equals(WorldNoOpValidation().validationAttempts)),
      Ensure.that(WorldNoOpVisibleId(), equals(WorldNoOpChangeId())),
      Ensure.that(WorldNoOpReadback().exact, equals(true)),
      Ensure.that(WorldNoOpReadback().activeReleaseUnchanged, equals(true)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldAuthoring());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World NoOp UI cleanup failed; the exact ledger entry is retained and no mutation is replayed');
    }
  }
});

test('World 真实 Task 下可选择新 Function；换批与移除撤销当前版本编译选择确认且禁用提交', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      OpenWorldAuthoring(),
      ChooseExistingWorldTask(),
      ImportWorldDefinition('first'),
      ChooseImportedWorldFunction('first'),
      Ensure.that(WorldSelectedFunction(), equals('function:e2e-authoring:first:1')),
      Ensure.that(WorldImportedFunctionOptionCount('replacement'), equals(0)),
      ConfirmWorldBaselineCompilation(),
      Ensure.that(WorldSubmitIsEnabled(), equals(true)),
      ImportWorldDefinition('replacement'),
      Ensure.that(WorldDefinitionPreview(), not(includes('function:e2e-authoring:first'))),
      Ensure.that(WorldCompilationNeedsConfirmation(), equals(true)),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
      ChooseImportedWorldFunction('replacement'),
      Ensure.that(WorldSelectedFunction(), equals('function:e2e-authoring:replacement:1')),
      Ensure.that(WorldImportedFunctionOptionCount('first'), equals(0)),
      ConfirmWorldBaselineCompilation(),
      Ensure.that(WorldSubmitIsEnabled(), equals(true)),
      RemoveWorldDefinition(),
      Ensure.that(WorldDefinitionPreviewCount(), equals(0)),
      Ensure.that(WorldCompilationNeedsConfirmation(), equals(true)),
      Ensure.that(WorldSubmitIsEnabled(), equals(false)),
      InspectWorldFunctionChoices(),
      Ensure.that(WorldImportedFunctionOptionCount('first'), equals(0)),
      Ensure.that(WorldImportedFunctionOptionCount('replacement'), equals(0)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(LeaveWorldAuthoring());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World Task/compile draft cleanup failed; the original failure is retained');
    }
  }
});
