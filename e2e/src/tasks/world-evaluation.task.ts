import { Ensure, equals, isGreaterThan } from '@serenity-js/assertions';
import { Check, Duration, Log, Task, Wait } from '@serenity-js/core';
import { Attribute, Click, Enter, isEnabled, isVisible } from '@serenity-js/web';
import {
  ArmWorldEvaluationConfirmation, ArmWorldEvaluationSelection, BeginWorldEvaluation, CompleteWorldEvaluationPicker,
  ReadWorldEvaluation, RecordWorldEvaluationEvidence, RecordWorldEvaluationPreview,
} from '../interactions/world-evaluation.interaction.js';
import { AccountPage } from '../pages/account.page.js';
import { WorldEvaluationPage } from '../pages/world-evaluation.page.js';
import {
  EvaluationConfirmationIsExact, EvaluationIdentityValues, EvaluationIsIdle, EvaluationIssues,
  EvaluationStatusHasSettled, EvaluationSummaryHasExactLabels, EvaluationSummaryValues, EvaluationUiOutcome,
  EvaluationWorldHasSettled, EvaluationWorldState, WorldEvaluationEvidence,
} from '../questions/world-evaluation.question.js';
import { StartAtSignIn } from './account.task.js';
import { EnterChat } from './chat.task.js';

const commitId = 'commit:eval-admin-ready-20261026-4e92d6a1';
const configuredStatus = { outcome: 'available', world: { tenantId: 'local', worldId: 'personal' }, configured: true, commitId };

const ReadConfiguredEvaluationUi = () => Task.where('#actor reads the original saved evaluation identity, not evidence of current execution permission',
  Wait.upTo(Duration.ofSeconds(45)).until(EvaluationStatusHasSettled(), equals(true)),
  Wait.upTo(Duration.ofSeconds(45)).until(EvaluationIsIdle(), equals(true)),
  Ensure.that(EvaluationIssues(), equals([])),
  Ensure.that(EvaluationUiOutcome(), equals(['configured'])),
  Ensure.that(EvaluationIdentityValues(), equals(['local / personal', commitId])),
  Ensure.that(WorldEvaluationPage.summaries.count(), equals(0)),
  Ensure.that(WorldEvaluationPage.choose.isEnabled(), equals(false)),
);

const ReadExistingEvaluation = () => Task.where('#actor explicitly replays an existing configuration read-only without claiming a new installation',
  ReadConfiguredEvaluationUi(),
  ReadWorldEvaluation('existing-config'),
  Ensure.that(WorldEvaluationEvidence().phase, equals('existing-config')),
  Ensure.that(WorldEvaluationEvidence().submissionAttempts, equals(0)),
  Ensure.that(WorldEvaluationEvidence().selections, equals(0)),
  Ensure.that(WorldEvaluationEvidence().status, equals(configuredStatus)),
  Log.the(WorldEvaluationEvidence()),
);

export const OpenWorldEvaluation = () => Task.where('#actor opens only existing local/personal through the World settings UI and pins the unchanged administrator input',
  StartAtSignIn(), EnterChat(),
  Check.whether(AccountPage.expandSidebar, isVisible()).andIfSo(Click.on(AccountPage.expandSidebar)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldEvaluationPage.navigationGroup, isEnabled()),
  Check.whether(Attribute.called('aria-expanded').of(WorldEvaluationPage.navigationGroup), equals('false'))
    .andIfSo(Click.on(WorldEvaluationPage.navigationGroup)),
  Click.on(WorldEvaluationPage.settingsNavigation),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldEvaluationPage.panels.count(), equals(1)),
  Check.whether(WorldEvaluationPage.tenant, isVisible()).andIfSo().otherwise(Click.on(WorldEvaluationPage.worldSelector)),
  Enter.theValue('local').into(WorldEvaluationPage.tenant),
  Enter.theValue('personal').into(WorldEvaluationPage.world),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldEvaluationPage.open, isEnabled()),
  Click.on(WorldEvaluationPage.open),
  Wait.upTo(Duration.ofSeconds(45)).until(EvaluationWorldHasSettled(), equals(true)),
  Ensure.that(EvaluationWorldState(), equals({ status: 'ready', errors: [] })),
  Wait.upTo(Duration.ofSeconds(45)).until(EvaluationStatusHasSettled(), equals(true)),
  Wait.upTo(Duration.ofSeconds(45)).until(EvaluationIsIdle(), equals(true)),
  Ensure.that(EvaluationIssues(), equals([])),
  Ensure.that(WorldEvaluationPage.dialogs.count(), equals(0)),
  BeginWorldEvaluation(),
  Log.the(WorldEvaluationEvidence()),
);

const PreviewOriginalEvaluation = () => Task.where('#actor uses the real OS picker for the same immutable original and checks all eight summary fields exactly',
  Ensure.that(WorldEvaluationEvidence().mode, equals('new-config')),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldEvaluationPage.choose, isEnabled()),
  ArmWorldEvaluationSelection(),
  Click.on(WorldEvaluationPage.choose),
  CompleteWorldEvaluationPicker(),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldEvaluationPage.summaries.count(), equals(1)),
  RecordWorldEvaluationPreview(),
  Wait.upTo(Duration.ofSeconds(45)).until(EvaluationIsIdle(), equals(true)),
  Ensure.that(EvaluationIssues(), equals([])),
  Ensure.that(WorldEvaluationPage.dialogs.count(), equals(0)),
  Ensure.that(WorldEvaluationPage.summaryRows.count(), equals(8)),
  Ensure.that(EvaluationSummaryHasExactLabels(), equals(true)),
  Ensure.that(EvaluationSummaryValues(), equals([
    'local / personal', commitId, '1', '2', '1', '1',
    'policy:eval-admin-ready-20261026-4e92d6a1:case-access / 1',
    'policy:eval-admin-ready-20261026-4e92d6a1:case-retention / 1',
  ])),
);

const CancelOriginalEvaluation = () => Task.where('#actor cancels the in-app World confirmation and independently observes no durable configuration',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldEvaluationPage.apply, isEnabled()),
  Click.on(WorldEvaluationPage.apply),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldEvaluationPage.dialogs.count(), equals(1)),
  Ensure.that(EvaluationConfirmationIsExact(), equals(true)),
  ArmWorldEvaluationConfirmation('cancel'),
  Click.on(WorldEvaluationPage.cancelConfirmation),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldEvaluationPage.dialogs.count(), equals(0)),
  Wait.upTo(Duration.ofSeconds(45)).until(EvaluationIsIdle(), equals(true)),
  Ensure.that(WorldEvaluationPage.summaries.count(), equals(0)),
  Ensure.that(EvaluationIssues(), equals([])),
  Ensure.that(EvaluationUiOutcome(), equals(['not-configured', 'cancelled'])),
  ReadWorldEvaluation('cancelled'),
  Ensure.that(WorldEvaluationEvidence().status, equals({
    outcome: 'available', world: { tenantId: 'local', worldId: 'personal' }, configured: false, commitId: null,
  })),
  Ensure.that(WorldEvaluationEvidence().submissionAttempts, equals(0)),
  Ensure.that(WorldEvaluationPage.choose.isEnabled(), equals(true)),
  Log.the(WorldEvaluationEvidence()),
);

const ConfirmOriginalEvaluationOnce = () => Task.where('#actor accepts the second exact preview once through the application dialog, stopping on every unknown or unconfirmed outcome',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldEvaluationPage.apply, isEnabled()),
  Click.on(WorldEvaluationPage.apply),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldEvaluationPage.dialogs.count(), equals(1)),
  Ensure.that(EvaluationConfirmationIsExact(), equals(true)),
  ArmWorldEvaluationConfirmation('submit'),
  Click.on(WorldEvaluationPage.acceptConfirmation),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldEvaluationPage.dialogs.count(), equals(0)),
  Wait.upTo(Duration.ofSeconds(45)).until(EvaluationIsIdle(), equals(true)),
  Ensure.that(EvaluationIssues(), equals([])),
  Ensure.that(EvaluationUiOutcome(), equals(['configured', 'confirmed'])),
  Ensure.that(EvaluationIdentityValues(), equals(['local / personal', commitId])),
  Ensure.that(WorldEvaluationPage.summaries.count(), equals(0)),
  Ensure.that(WorldEvaluationPage.choose.isEnabled(), equals(false)),
  ReadWorldEvaluation('confirmed'),
  Ensure.that(WorldEvaluationEvidence().status, equals(configuredStatus)),
  Ensure.that(WorldEvaluationEvidence().submissionAttempts, equals(1)),
  Ensure.that(WorldEvaluationEvidence().selections, equals(2)),
  Log.the(WorldEvaluationEvidence()),
);

export const CheckWorldEvaluationCancellation = () => Task.where('#actor verifies summary and application cancellation, or explicitly reads the already-installed original without reimporting',
  Check.whether(WorldEvaluationEvidence().mode, equals('existing-config'))
    .andIfSo(ReadExistingEvaluation())
    .otherwise(PreviewOriginalEvaluation(), CancelOriginalEvaluation()),
);

export const SaveWorldEvaluationOnce = () => Task.where('#actor independently cancels then reselects the same original and accepts once, or reads an existing original only',
  Check.whether(WorldEvaluationEvidence().mode, equals('existing-config'))
    .andIfSo(ReadExistingEvaluation())
    .otherwise(PreviewOriginalEvaluation(), CancelOriginalEvaluation(), PreviewOriginalEvaluation(), ConfirmOriginalEvaluationOnce()),
);

export const ReturnToSavedWorldEvaluation = () => Task.where('#actor leaves and returns through normal navigation with the same exact durable configuration and no reinitialization',
  Click.on(WorldEvaluationPage.modelNavigation),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldEvaluationPage.panels.count(), equals(0)),
  Click.on(WorldEvaluationPage.settingsNavigation),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldEvaluationPage.panels.count(), equals(1)),
  ReadConfiguredEvaluationUi(),
  Ensure.that(WorldEvaluationPage.dialogs.count(), equals(0)),
  ReadWorldEvaluation('returned'),
  Ensure.that(WorldEvaluationEvidence().status, equals(configuredStatus)),
  Log.the(WorldEvaluationEvidence()),
);

export const PreserveWorldEvaluation = () => Task.where('#actor records the last phase and leaves only settled or unsubmitted UI; an unresolved submission retains its original scene',
  RecordWorldEvaluationEvidence(),
  Log.the(WorldEvaluationEvidence()),
  Check.whether(WorldEvaluationEvidence().mayLeave, equals(true)).andIfSo(
    Check.whether(WorldEvaluationPage.dialogs.count(), equals(1)).andIfSo(Click.on(WorldEvaluationPage.cancelConfirmation)),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldEvaluationPage.dialogs.count(), equals(0)),
    Check.whether(WorldEvaluationPage.panels.count(), isGreaterThan(0)).andIfSo(Click.on(WorldEvaluationPage.modelNavigation)),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldEvaluationPage.panels.count(), equals(0)),
  ),
);
