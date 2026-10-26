import { Ensure, equals, isGreaterThan } from '@serenity-js/assertions';
import type { Answerable } from '@serenity-js/core';
import { Check, Duration, List, Log, Task, Wait } from '@serenity-js/core';
import type { PageElement } from '@serenity-js/web';
import { Click, Select, Text, isEnabled, isVisible } from '@serenity-js/web';
import {
  ConfirmWorldOrderProposal, ConfirmWorldOrderRegistration, ConfirmWorldOrderValidation,
  ImportWorldOrderDefinitionFile, ImportWorldOrderTaskFile, MarkWorldOrderProposal, MarkWorldOrderRegistration,
  MarkWorldOrderValidation, ReadWorldOrderOriginals, ReadWorldOrderProposalPrerequisites, ReadWorldOrderTask,
  PrepareWorldOrderStructure, ReadWorldOrderStructure, ReleaseWorldOrderObservation,
} from '../interactions/world-compilation.interaction.js';
import { WorldAuthoringPage } from '../pages/world-authoring.page.js';
import { WorldCompilationPage } from '../pages/world-compilation.page.js';
import {
  WorldCompilationIsConfirmed, WorldCurrentBaselineIsSelected, WorldDefinitionFileIsAvailable,
  WorldDefinitionPreviewCount, WorldTasksHaveSettled,
} from '../questions/world-authoring.question.js';
import {
  WorldOrderCompileGroupCount, WorldOrderDraftIsGone, WorldOrderFunctionOptionCount,
  WorldOrderNoOpDraftTaskValue, WorldOrderTaskPreviewCount, WorldOrderTaskIsRecorded,
  WorldOrderTaskIsExact, WorldOrderTaskPreviewMatchesOriginal, WorldOrderRegistrationHasResponded,
  WorldOrderOperationIsSettled, WorldOrderRecordedTaskValue, WorldOrderRegistrationErrors,
  WorldOrderDefinitionPreview, WorldOrderOriginalDefinitions, WorldOrderProposalPrerequisites,
  WorldOrderProposal, WorldOrderValidation, WorldOrderSelectedChangeId, WorldOrderStructureMode, WorldOrderStructureResume,
} from '../questions/world-compilation.question.js';
import { OpenWorldAuthoring } from './world-authoring.task.js';

const OpenExactWorldOrderChange = (changeId: Answerable<string>, revision: Answerable<string>) => {
  const matches: PageElement[] = [];
  return Task.where('#actor reviews matching order summaries and selects exactly one verified World change identity',
    WorldCompilationPage.orderChangeCandidates.forEach(async ({ actor, item: candidate }) => {
      await actor.attemptsTo(
        Click.on(candidate),
        Check.whether(WorldCompilationPage.changeValue(['id']), isVisible()).andIfSo()
          .otherwise(Click.on(WorldCompilationPage.changeIdentity)),
      );
      const id = await actor.answer(changeId);
      if (await actor.answer(WorldOrderSelectedChangeId()) !== id) return;
      await actor.attemptsTo(
        Ensure.that(Text.of(WorldCompilationPage.changeValue(['id'])), equals(id)),
        Ensure.that(Text.of(WorldCompilationPage.changeValue(['revision'])), equals(revision)),
        Ensure.that(Text.of(WorldCompilationPage.changeValue(['world', 'tenantId'])), equals('local')),
        Ensure.that(Text.of(WorldCompilationPage.changeValue(['world', 'worldId'])), equals('personal')),
      );
      matches.push(candidate);
    }),
    Ensure.that(List.of(matches).count(), equals(1)),
    List.of(matches).forEach(async ({ actor, item }) => { await actor.attemptsTo(Click.on(item)); }),
  );
};

export const OpenWorldOrderTaskPreview = () => Task.where('#actor opens the actual order Task original as a review-only import, retaining its old Oracle pin unchanged',
  OpenWorldAuthoring(), ReadWorldOrderOriginals(),
  Click.on(WorldCompilationPage.versionTab),
  Click.on(WorldCompilationPage.taskImport), ImportWorldOrderTaskFile(),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldOrderTaskPreviewCount(), equals(1)),
);

export const RegisterOriginalWorldOrderTask = () => Task.where('#actor registers the unchanged original order Task once through UI, or reads an already exact contract without replay',
  ReadWorldOrderTask(),
  Check.whether(WorldOrderTaskIsRecorded(), equals(false)).andIfSo(
    Ensure.that(WorldOrderTaskPreviewMatchesOriginal(), equals(true)),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldCompilationPage.registerTask, isEnabled()),
    MarkWorldOrderRegistration(), Click.on(WorldCompilationPage.registerTask),
    Wait.upTo(Duration.ofSeconds(45)).until(WorldOrderRegistrationHasResponded(), equals(true)),
    Ensure.that(WorldOrderRegistrationErrors(), equals([])),
    Check.whether(WorldCompilationPage.operationRecords.count(), equals(1)).andIfSo(
      Wait.upTo(Duration.ofSeconds(45)).until(WorldOrderOperationIsSettled(), equals(true)),
      ConfirmWorldOrderRegistration(),
    ),
    ReadWorldOrderTask(),
  ),
  Ensure.that(WorldOrderTaskIsRecorded(), equals(true)),
  Ensure.that(WorldOrderTaskIsExact(), equals(true)),
  Click.on(WorldCompilationPage.modelNavigation),
  Click.on(WorldAuthoringPage.authoringTab),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldDefinitionFileIsAvailable(), equals(true)),
  Select.value('scope:personal:management').from(WorldAuthoringPage.scope),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldTasksHaveSettled(), equals(true)),
  Ensure.that(WorldCompilationPage.orderTaskOptions.count(), equals(1)),
  Select.value(WorldOrderRecordedTaskValue()).from(WorldAuthoringPage.task),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.targetLock, isEnabled()),
);

export const PreviewWorldOrderDefinitions = () => Task.where('#actor cancels the unregistered Task import and previews the original non-empty Function and Strategy',
  Click.on(WorldCompilationPage.cancelTaskImport),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldOrderTaskPreviewCount(), equals(0)),
  Click.on(WorldAuthoringPage.authoringTab),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldDefinitionFileIsAvailable(), equals(true)),
  Select.value('scope:personal:management').from(WorldAuthoringPage.scope),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldDefinitionFileIsAvailable(), equals(true)),
  ImportWorldOrderDefinitionFile(),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldDefinitionPreviewCount(), equals(1)),
);

export const SelectWorldOrderCompileDraft = () => Task.where('#actor uses only the original NoOp Task to inspect an order Function dropdown and confirm a UI draft, never compile or submit',
  Wait.upTo(Duration.ofSeconds(45)).until(WorldTasksHaveSettled(), equals(true)),
  Select.value(WorldOrderNoOpDraftTaskValue()).from(WorldAuthoringPage.task),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.targetLock, isEnabled()),
  Click.on(WorldAuthoringPage.addUse),
  Select.value('function').from(WorldAuthoringPage.use),
  Ensure.that(WorldOrderFunctionOptionCount(), equals(1)),
  Select.value('function:order-line-total:20261026:r1:1').from(WorldAuthoringPage.functionDefinition),
  Ensure.that(WorldCurrentBaselineIsSelected(), equals(true)),
  Click.on(WorldAuthoringPage.confirm),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldCompilationIsConfirmed(), equals(true)),
);

export const CancelWorldOrderTaskSelection = () => Task.where('#actor clears the unrelated NoOp Task and requires the whole compilation confirmation to be discarded',
  Select.value('').from(WorldAuthoringPage.task),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldOrderCompileGroupCount(), equals(0)),
);

export const ReselectWorldOrderCompileDraft = () => Task.where('#actor reselects the original NoOp Task as UI draft only; no previous confirmation can survive',
  Select.value(WorldOrderNoOpDraftTaskValue()).from(WorldAuthoringPage.task),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.targetLock, isEnabled()),
);

export const ProposeOriginalWorldOrderDefinitions = () => Task.where('#actor submits the two unchanged order definitions once through normal authoring, checking structure but never executing Schema',
  ImportWorldOrderDefinitionFile(),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldDefinitionPreviewCount(), equals(1)),
  Ensure.that(WorldOrderDefinitionPreview(), equals(WorldOrderOriginalDefinitions())),
  Ensure.that(WorldCurrentBaselineIsSelected(), equals(true)),
  ReadWorldOrderProposalPrerequisites(),
  Ensure.that(WorldOrderProposalPrerequisites().status, equals('ready')),
  Click.on(WorldAuthoringPage.confirm),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldCompilationIsConfirmed(), equals(true)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.submit, isEnabled()),
  MarkWorldOrderProposal(), Click.on(WorldAuthoringPage.submit),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.changesHeadings.count(), equals(1)),
  Ensure.that(WorldOrderRegistrationErrors(), equals([])),
  ConfirmWorldOrderProposal(), Log.the(WorldOrderProposal()),
  OpenExactWorldOrderChange(WorldOrderProposal().id, WorldOrderProposal().revision),
  Ensure.that(WorldOrderSelectedChangeId(), equals(WorldOrderProposal().id)),
);

export const ValidateOriginalWorldOrderDefinitions = () => Task.where('#actor validates only the newly proposed exact order revision and observes the same branch, without evaluation or publication',
  Ensure.that(WorldOrderSelectedChangeId(), equals(WorldOrderProposal().id)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.validate, isEnabled()),
  MarkWorldOrderValidation(), Click.on(WorldAuthoringPage.validate),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.validated.count(), equals(1)),
  Ensure.that(WorldOrderRegistrationErrors(), equals([])),
  ConfirmWorldOrderValidation(), Log.the(WorldOrderValidation()),
);

export const PrepareWorldOrderStructureReview = () => Task.where('#actor chooses a fresh one-shot proposal or an explicit read-only persisted-result replay after normal local entry',
  OpenWorldAuthoring(), PrepareWorldOrderStructure(),
);

export const ResumeOriginalWorldOrderStructure = () => Task.where('#actor reads only the explicitly recorded validated structure and opens its exact normal UI review without submitting any command',
  Ensure.that(WorldOrderStructureMode(), equals('resume')),
  ReadWorldOrderStructure(), Log.the(WorldOrderStructureResume()),
  Click.on(WorldAuthoringPage.changesNavigation),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.changesHeadings.count(), equals(1)),
  OpenExactWorldOrderChange(WorldOrderStructureResume().record.changeId, WorldOrderStructureResume().change.revision),
  Ensure.that(WorldOrderSelectedChangeId(), equals(WorldOrderStructureResume().record.changeId)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.validated.count(), equals(1)),
  Ensure.that(WorldOrderRegistrationErrors(), equals([])),
  ReadWorldOrderStructure(), Log.the(WorldOrderStructureResume()),
);

export const LeaveWorldOrderReview = () => Task.where('#actor releases the owned event observer and closes only its review selection; no durable change is undone or replayed',
  ReleaseWorldOrderObservation(),
  Check.whether(WorldCompilationPage.selectedChanges.count(), equals(1)).andIfSo(Click.on(WorldCompilationPage.closeChange)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldCompilationPage.selectedChanges.count(), equals(0)),
  LeaveWorldOrderDraft(),
);

export const LeaveWorldOrderDraft = () => Task.where('#actor discards only the owned order authoring and Task import UI state through the relation canvas',
  Check.whether(WorldCompilationPage.canvasTabs.count(), isGreaterThan(0)).andIfSo(
    Click.on(WorldAuthoringPage.canvasTab),
  ),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldOrderDraftIsGone(), equals(true)),
);
