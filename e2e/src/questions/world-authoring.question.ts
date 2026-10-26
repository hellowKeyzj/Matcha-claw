import { Question, notes } from '@serenity-js/core';
import { Attribute, Selected, Text } from '@serenity-js/web';
import { WorldAuthoringPage } from '../pages/world-authoring.page.js';

type WorldNoOpReceipt = {
  id: string; revision: string; status: string; exact: boolean; activeReleaseUnchanged: boolean;
  phase: string; validationAttempts: number;
};
type WorldNoOpNotes = {
  worldNoOp: { mode: 'resume' | 'propose'; reason: string; taskValue: string };
  worldNoOpInitial: WorldNoOpReceipt;
  worldNoOpReadback: WorldNoOpReceipt;
  worldNoOpValidation: WorldNoOpReceipt;
  worldNoOpRefresh: WorldNoOpReceipt;
};
export const WorldNoOpMode = () => notes<WorldNoOpNotes>().get('worldNoOp').mode;
export const WorldNoOpReason = () => notes<WorldNoOpNotes>().get('worldNoOp').reason;
export const WorldNoOpTaskValue = () => notes<WorldNoOpNotes>().get('worldNoOp').taskValue;
export const WorldNoOpChangeId = () => notes<WorldNoOpNotes>().get('worldNoOpReadback').id;
export const WorldNoOpReadback = () => notes<WorldNoOpNotes>().get('worldNoOpReadback');
export const WorldNoOpInitial = () => notes<WorldNoOpNotes>().get('worldNoOpInitial');
export const WorldNoOpValidation = () => notes<WorldNoOpNotes>().get('worldNoOpValidation');
export const WorldNoOpRefresh = () => notes<WorldNoOpNotes>().get('worldNoOpRefresh');
export const WorldNoOpVisibleId = () => Text.of(WorldAuthoringPage.changeId);

export const WorldOpeningHasSettled = () => Question.about('World opening returns a status or an explicit error', async actor =>
  await actor.answer(WorldAuthoringPage.statuses.count()) > 0 || await actor.answer(WorldAuthoringPage.errors.count()) > 0,
);
export const WorldOpeningState = () => Question.about('the opened World status and visible errors', async actor => ({
  status: await actor.answer(WorldAuthoringPage.statuses.count()) === 1
    ? await actor.answer(Attribute.called('data-status').of(WorldAuthoringPage.status)) : null,
  errors: await actor.answer(Text.ofAll(WorldAuthoringPage.errors)),
}));
export const WorldDefinitionFileIsAvailable = () => Question.about('the manual definition file input is visible and enabled', async actor =>
  await actor.answer(WorldAuthoringPage.file.isVisible()) && await actor.answer(WorldAuthoringPage.file.isEnabled()),
);
export const ExistingWorldScopeValue = () => Question.about('an actual non-empty scope option in the authoring UI', async actor => {
  if (await actor.answer(WorldAuthoringPage.scopeOptions.count()) === 0) {
    throw new Error('World authoring requires an existing readable non-empty scope option; no scope is fabricated');
  }
  return actor.answer(Attribute.called('value').of(WorldAuthoringPage.scopeOptions.first()));
});
export const WorldTasksHaveSettled = () => Question.about('the selected World scope returns real Tasks, an empty result or an error', async actor =>
  await actor.answer(WorldAuthoringPage.taskOptions.count()) > 0
  || await actor.answer(WorldAuthoringPage.noTasks.isVisible())
  || await actor.answer(WorldAuthoringPage.errors.count()) > 0,
);
export const ExistingWorldTaskValue = () => Question.about('a real readable Task option, never a guessed index or invented task', async actor => {
  if (await actor.answer(WorldAuthoringPage.taskOptions.count()) === 0) {
    const errors = await actor.answer(Text.ofAll(WorldAuthoringPage.errors));
    throw new Error(`World compile selection requires a real readable Task in the selected scope; none was returned. ${errors.join(' ')}`);
  }
  return actor.answer(Attribute.called('value').of(WorldAuthoringPage.taskOptions.first()));
});
export const WorldDefinitionPreview = () => Text.of(WorldAuthoringPage.preview);
export const WorldDefinitionPreviewSummary = () => Text.of(WorldAuthoringPage.previewSummary);
export const WorldDefinitionPreviewCount = () => WorldAuthoringPage.previews.count();
export const WorldSubmitIsEnabled = () => WorldAuthoringPage.submit.isEnabled();
export const WorldImportedFunctionOptionCount = (batch: 'first' | 'replacement') => WorldAuthoringPage.functionOption(batch).count();
export const WorldSelectedFunction = () => Selected.valueOf(WorldAuthoringPage.functionDefinition);
export const WorldCurrentBaselineIsSelected = () => Question.about('the compile target is the real current-version baseline', async actor =>
  await actor.answer(WorldAuthoringPage.baselineLocks.count()) === 1
  && await actor.answer(Selected.valueOf(WorldAuthoringPage.targetLock))
    === await actor.answer(Attribute.called('value').of(WorldAuthoringPage.baselineLock)),
);
export const WorldBaselineUseCount = () => WorldAuthoringPage.externalUses.count();
export const WorldCompilationIsConfirmed = () => WorldAuthoringPage.confirmations.count().as(count => count === 1);
export const WorldCompilationNeedsConfirmation = () => Question.about('the old compile confirmation is revoked', async actor =>
  await actor.answer(WorldAuthoringPage.confirmations.count()) === 0
  && await actor.answer(WorldAuthoringPage.pendingConfirmations.count()) === 1,
);
export const WorldAuthoringDraftIsGone = () => Question.about('normal navigation unmounted the owned authoring draft', async actor =>
  await actor.answer(WorldAuthoringPage.authoringPanels.count()) === 0
  && await actor.answer(WorldAuthoringPage.files.count()) === 0
  && await actor.answer(WorldAuthoringPage.remainingPreviews.count()) === 0,
);
