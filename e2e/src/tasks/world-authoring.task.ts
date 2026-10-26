import { Ensure, equals, includes, isGreaterThan } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Attribute, Click, Enter, Scroll, Select, isEnabled, isVisible } from '@serenity-js/web';
import { MarkWorldNoOpSubmission, PrepareIndependentWorldNoOp, ReadWorldNoOp, UploadWorldDefinition } from '../interactions/world-authoring.interaction.js';
import { AccountPage } from '../pages/account.page.js';
import { WorldAuthoringPage } from '../pages/world-authoring.page.js';
import {
  ExistingWorldScopeValue, ExistingWorldTaskValue, WorldAuthoringDraftIsGone, WorldBaselineUseCount,
  WorldCompilationIsConfirmed, WorldCurrentBaselineIsSelected, WorldDefinitionFileIsAvailable,
  WorldDefinitionPreview, WorldDefinitionPreviewCount, WorldImportedFunctionOptionCount, WorldOpeningHasSettled,
  WorldOpeningState, WorldTasksHaveSettled, WorldNoOpReason, WorldNoOpTaskValue, WorldNoOpMode,
  WorldNoOpChangeId, WorldNoOpReadback, WorldNoOpVisibleId,
} from '../questions/world-authoring.question.js';
import { StartAtSignIn } from './account.task.js';
import { EnterChat } from './chat.task.js';

export const OpenWorldAuthoring = () => Task.where('#actor continues locally and opens the existing local/personal World through sidebar Models & rules',
  StartAtSignIn(),
  EnterChat(),
  Check.whether(AccountPage.expandSidebar, isVisible()).andIfSo(Click.on(AccountPage.expandSidebar)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.navigationGroup, isEnabled()),
  Check.whether(Attribute.called('aria-expanded').of(WorldAuthoringPage.navigationGroup), equals('false'))
    .andIfSo(Click.on(WorldAuthoringPage.navigationGroup)),
  Click.on(WorldAuthoringPage.modelNavigation),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.heading, isVisible()),
  Check.whether(WorldAuthoringPage.tenant, isVisible()).andIfSo().otherwise(Click.on(WorldAuthoringPage.worldSelector)),
  Enter.theValue('local').into(WorldAuthoringPage.tenant),
  Enter.theValue('personal').into(WorldAuthoringPage.world),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.open, isEnabled()),
  Click.on(WorldAuthoringPage.open),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldOpeningHasSettled(), equals(true)),
  Ensure.that(WorldOpeningState(), equals({ status: 'ready', errors: [] })),
  Click.on(WorldAuthoringPage.authoringTab),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldDefinitionFileIsAvailable(), equals(true)),
  Select.value(ExistingWorldScopeValue()).from(WorldAuthoringPage.scope),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldDefinitionFileIsAvailable(), equals(true)),
);

export const ImportWorldDefinition = (batch: 'first' | 'replacement') => Task.where(`#actor previews the ${batch} Function file without submitting a change`,
  Scroll.to(WorldAuthoringPage.file),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldDefinitionFileIsAvailable(), equals(true)),
  UploadWorldDefinition(batch),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldDefinitionPreviewCount(), equals(1)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldDefinitionPreview(), includes(`function:e2e-authoring:${batch}`)),
);

export const RemoveWorldDefinition = () => Task.where('#actor removes only the imported definition draft',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.remove, isEnabled()),
  Click.on(WorldAuthoringPage.remove),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldDefinitionPreviewCount(), equals(0)),
);

export const ChooseExistingWorldTask = () => Task.where('#actor selects a real Task returned for the actual UI scope, failing if none is readable',
  Wait.upTo(Duration.ofSeconds(45)).until(WorldTasksHaveSettled(), equals(true)),
  Select.value(ExistingWorldTaskValue()).from(WorldAuthoringPage.task),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.targetLock, isEnabled()),
);

export const InspectWorldFunctionChoices = () => Task.where('#actor opens the explicit-use editor and inspects Function definitions without adding an external use',
  Click.on(WorldAuthoringPage.addUse),
  Select.value('function').from(WorldAuthoringPage.use),
);

export const ChooseImportedWorldFunction = (batch: 'first' | 'replacement') => Task.where(`#actor selects the ${batch} imported Function in the dropdown only`,
  InspectWorldFunctionChoices(),
  Ensure.that(WorldImportedFunctionOptionCount(batch), equals(1)),
  Select.value(`function:e2e-authoring:${batch}:1`).from(WorldAuthoringPage.functionDefinition),
);

export const ConfirmWorldBaselineCompilation = () => Task.where('#actor confirms the actual current-version target and external-use selection without adding a Function use',
  Ensure.that(WorldCurrentBaselineIsSelected(), equals(true)),
  Ensure.that(WorldBaselineUseCount(), equals(0)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.confirm, isEnabled()),
  Click.on(WorldAuthoringPage.confirm),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldCompilationIsConfirmed(), equals(true)),
);

export const PrepareWorldNoOp = () => Task.where('#actor binds the original zero-effect Task and reads the exact original NoOp unless a new proposal is explicitly requested',
  Wait.upTo(Duration.ofSeconds(45)).until(WorldTasksHaveSettled(), equals(true)),
  PrepareIndependentWorldNoOp(),
  Check.whether(WorldNoOpMode(), equals('propose')).andIfSo(
    Select.value(WorldNoOpTaskValue()).from(WorldAuthoringPage.task),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringPage.targetLock, isEnabled()),
    Ensure.that(WorldDefinitionPreviewCount(), equals(0)),
    Enter.theValue(WorldNoOpReason()).into(WorldAuthoringPage.noOpReason),
    Ensure.that(WorldCurrentBaselineIsSelected(), equals(true)),
    Ensure.that(WorldBaselineUseCount(), equals(0)),
    Click.on(WorldAuthoringPage.confirm),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldCompilationIsConfirmed(), equals(true)),
  ),
);

export const SubmitWorldNoOp = () => Task.where('#actor either resumes the exact persisted review record or submits once and requires automatic Changes navigation',
  Check.whether(WorldNoOpMode(), equals('resume')).andIfSo(
    Click.on(WorldAuthoringPage.changesNavigation),
    Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.changesHeadings.count(), equals(1)),
  ).otherwise(
    Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.submit, isEnabled()),
    MarkWorldNoOpSubmission('proposal'), Click.on(WorldAuthoringPage.submit),
    Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.changesHeadings.count(), equals(1)),
  ),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.ownChange(WorldNoOpReason()), isEnabled()),
  Click.on(WorldAuthoringPage.ownChange(WorldNoOpReason())),
  Check.whether(WorldNoOpMode(), equals('propose')).andIfSo(ReadWorldNoOp('proposal')),
  Ensure.that(WorldNoOpVisibleId(), equals(WorldNoOpChangeId())),
);

export const ValidateWorldNoOp = () => Task.where('#actor validates only an exact proposed revision once, or records an already-validated read-only replay without clicking Validate',
  Check.whether(WorldNoOpReadback().status, equals('proposed')).andIfSo(
    Ensure.that(WorldNoOpReadback().revision, equals('1')),
    Ensure.that(WorldNoOpVisibleId(), equals(WorldNoOpChangeId())),
    Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.validate, isEnabled()),
    ReadWorldNoOp('before-validation'),
    MarkWorldNoOpSubmission('validation'), Click.on(WorldAuthoringPage.validate),
    Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.ownValidatedChange(WorldNoOpReason()), isVisible()),
    Click.on(WorldAuthoringPage.ownChange(WorldNoOpReason())),
    Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.validated.count(), equals(1)),
    ReadWorldNoOp('validation'),
  ).otherwise(
    Ensure.that(WorldNoOpReadback().status, equals('validated')),
    Ensure.that(WorldNoOpReadback().revision, equals('2')),
    Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.validated.count(), equals(1)),
    ReadWorldNoOp('replay'),
  ),
);

export const RefreshWorldNoOp = () => Task.where('#actor refreshes and rereads the same complete validated NoOp without publishing or deleting ledger history',
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.refresh, isEnabled()),
  Click.on(WorldAuthoringPage.refresh),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.ownChange(WorldNoOpReason()), isEnabled()),
  Click.on(WorldAuthoringPage.ownChange(WorldNoOpReason())),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldAuthoringPage.validated.count(), equals(1)),
  ReadWorldNoOp('refresh'),
);

export const LeaveWorldAuthoring = () => Task.where('#actor discards the owned temporary authoring state by normal canvas navigation without reopening a failed World',
  Check.whether(WorldAuthoringPage.authoringPanels.count(), isGreaterThan(0)).andIfSo(Click.on(WorldAuthoringPage.canvasTab)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldAuthoringDraftIsGone(), equals(true)),
);
