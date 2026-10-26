import { Ensure, equals, isGreaterThan } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Attribute, Click, Enter, Select, isEnabled, isVisible } from '@serenity-js/web';
import {
  ConfirmWorkspaceOriginals, ReadMissingWorkspaceOperation, ReadRenderedWorkspaceTask, ReadWorkspaceCatalogs,
  ReadWorkspaceObjectsDecodeFailures, ReadWorkspaceOperation, ReadWorkspaceSession, ReadWorkspaceTask, RememberWorkspaceOriginals, ReachOriginalWorkspaceTask,
} from '../interactions/world-workspace.interaction.js';
import { AccountPage } from '../pages/account.page.js';
import { WorldWorkspacePage } from '../pages/world-workspace.page.js';
import {
  WorkspaceAbstractions, WorkspaceActions, WorkspaceCatalogs, WorkspaceChanges, WorkspaceConnections, WorkspaceDefinitions,
  WorkspaceEvaluations, WorkspaceExpectedActions, WorkspaceExpectedChanges, WorkspaceExpectedConnections,
  WorkspaceExpectedDefinitions, WorkspaceExpectedEvaluations, WorkspaceExpectedMaterials, WorkspaceExpectedProposals,
  WorkspaceFirstTaskRows, WorkspaceLeft, WorkspaceMaterials, WorkspaceMissing, WorkspaceOpeningSettled,
  WorkspaceTrackedCount, WorkspaceOperationErrorTexts, MaterialPolicySelections,
  WorkspaceOperationSettled, WorkspaceOriginalAuthoringSelected, WorkspaceProposals, WorkspaceResolutionErrors,
  WorkspaceResolutionSettled, WorkspaceSession, WorkspaceSessionCount, WorkspaceSessionValues, WorkspaceState, WorkspaceTask,
  WorkspaceTaskRows, WorkspaceTests, WorkspaceNavigation,
} from '../questions/world-workspace.question.js';
import { StartAtSignIn } from './account.task.js';
import { EnterChat } from './chat.task.js';

const ready = () => Ensure.that(WorkspaceState(), equals({ status: 'ready', errors: [] }));
export const OpenExistingWorldWorkspace = () => Task.where('#actor enters the existing local/personal World through normal sidebar navigation',
  StartAtSignIn(), EnterChat(),
  Check.whether(AccountPage.expandSidebar, isVisible()).andIfSo(Click.on(AccountPage.expandSidebar)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.navigationGroup, isEnabled()),
  Check.whether(Attribute.called('aria-expanded').of(WorldWorkspacePage.navigationGroup), equals('false')).andIfSo(Click.on(WorldWorkspacePage.navigationGroup)),
  Click.on(WorldWorkspacePage.modelNavigation),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.modelHeading, isVisible()),
  Check.whether(WorldWorkspacePage.tenant, isVisible()).andIfSo().otherwise(Click.on(WorldWorkspacePage.worldSelector)),
  Enter.theValue('local').into(WorldWorkspacePage.tenant), Enter.theValue('personal').into(WorldWorkspacePage.world),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.open, isEnabled()), Click.on(WorldWorkspacePage.open),
  Wait.upTo(Duration.ofSeconds(45)).until(WorkspaceOpeningSettled(), equals(true)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.refresh, isEnabled()), ready(),
);
export const OpenWorldWorkspace = () => Task.where('#actor enters the existing World and remembers its original workspace facts',
  OpenExistingWorldWorkspace(), RememberWorkspaceOriginals(),
);

const refreshRound = (round: number) => Task.where(`#actor refreshes normally and concurrently reads all six complete authorized directories, round ${round}`,
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.refresh, isEnabled()), Click.on(WorldWorkspacePage.refresh),
  ReadWorkspaceCatalogs(round), Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.refresh, isEnabled()), ready(),
  Ensure.that(WorkspaceDefinitions(), equals(WorkspaceExpectedDefinitions())),
);
export const InspectWorldDirectories = () => Task.where('#actor verifies five bounded concurrent-read rounds and all six real UI catalog projections across the four World pages',
  ...[1, 2, 3, 4, 5].map(refreshRound),
  Ensure.that(WorkspaceCatalogs().rounds, equals(5)), Ensure.that(WorkspaceCatalogs().complete, equals(true)),
  Click.on(WorldWorkspacePage.dataNavigation), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.dataHeading, isVisible()), ready(),
  Click.on(WorldWorkspacePage.materialsTab), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.materials, isVisible()),
  Ensure.that(WorkspaceMaterials(), equals(WorkspaceExpectedMaterials())), ready(),
  Ensure.that(WorkspaceConnections(), equals(WorkspaceExpectedConnections())),
  Click.on(WorldWorkspacePage.actionsTab), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.actions, isVisible()),
  Ensure.that(WorkspaceProposals(), equals(WorkspaceExpectedProposals())), Ensure.that(WorkspaceActions(), equals(WorkspaceExpectedActions())), ready(),
  Click.on(WorldWorkspacePage.changesNavigation), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.changesHeading, isVisible()), ready(),
  Ensure.that(WorkspaceChanges(), equals(WorkspaceExpectedChanges())), Click.on(WorldWorkspacePage.evaluationTab),
  Ensure.that(WorkspaceEvaluations(), equals(WorkspaceExpectedEvaluations())),
  Click.on(WorldWorkspacePage.settingsNavigation), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.settingsHeading, isVisible()), ready(),
  ConfirmWorkspaceOriginals(),
);

export const InspectWorldNavigation = () => Task.where('#actor verifies normal and rapid World sidebar navigation commits the matching page, then reads original facts unchanged',
  ...[1, 2, 3].map(round => Task.where(`#actor checks sidebar and heading consistency, round ${round}`,
    Click.on(WorldWorkspacePage.changesNavigation),
    Wait.upTo(Duration.ofSeconds(15)).until(WorkspaceNavigation(), equals({ links: ['#/world/changes'], tabs: ['#/world/changes'], headings: ['#/world/changes'] })),
    Click.on(WorldWorkspacePage.modelNavigation),
    Wait.upTo(Duration.ofSeconds(15)).until(WorkspaceNavigation(), equals({ links: ['#/world/model'], tabs: ['#/world/model'], headings: ['#/world/model'] })),
    Click.on(WorldWorkspacePage.settingsNavigation),
    Wait.upTo(Duration.ofSeconds(15)).until(WorkspaceNavigation(), equals({ links: ['#/world/settings'], tabs: ['#/world/settings'], headings: ['#/world/settings'] })),
    Click.on(WorldWorkspacePage.modelNavigation), Click.on(WorldWorkspacePage.settingsNavigation),
    Click.on(WorldWorkspacePage.changesNavigation), Click.on(WorldWorkspacePage.settingsNavigation),
    Wait.upTo(Duration.ofSeconds(15)).until(WorkspaceNavigation(), equals({ links: ['#/world/settings'], tabs: ['#/world/settings'], headings: ['#/world/settings'] })),
    ready(),
  )),
  ConfirmWorkspaceOriginals(),
);

export const InspectWorldObjectsDecodeFailures = () => Task.where('#actor verifies public objects input rejection then recovers through legal discover, original Task and NoOp reads, not a successful objects query',
  ReadWorkspaceObjectsDecodeFailures(), ConfirmWorkspaceOriginals(),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.refresh, isEnabled()), Click.on(WorldWorkspacePage.refresh),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.refresh, isEnabled()), ready(),
);

export const InspectOriginalWorldTask = () => Task.where('#actor reads the original Task through management UI and checks the actual composed TaskResolution prerequisite',
  ReadWorkspaceTask(), Click.on(WorldWorkspacePage.versionTab),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.taskScope, isEnabled()), Select.value(WorkspaceTask().scope).from(WorldWorkspacePage.taskScope),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.taskRefresh, isEnabled()), Click.on(WorldWorkspacePage.taskRefresh),
  Wait.upTo(Duration.ofSeconds(45)).until(WorkspaceTaskRows(), equals(WorkspaceFirstTaskRows())),
  ReachOriginalWorkspaceTask('management'), Click.on(WorldWorkspacePage.resolutionSummary),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.resolutionTask, isEnabled()),
  Select.value(WorkspaceTask().taskValue).from(WorldWorkspacePage.resolutionTask),
  Wait.upTo(Duration.ofSeconds(45)).until(WorkspaceResolutionSettled(), equals(true)),
  Check.whether(WorkspaceTask().evaluation, equals('not-configured')).andIfSo(
    Ensure.that(WorkspaceResolutionErrors(), equals(WorkspaceTask().error.as(error => [error]))),
    Ensure.that(WorldWorkspacePage.fullContracts.count(), equals(0)), Ensure.that(WorldWorkspacePage.resolveButtons.count(), equals(0)),
  ).otherwise(
    Ensure.that(WorkspaceResolutionErrors(), equals([])), Ensure.that(WorldWorkspacePage.fullContracts.count(), equals(1)),
    Click.on(WorldWorkspacePage.fullContractSummary), ReadRenderedWorkspaceTask(),
    Ensure.that(WorkspaceAbstractions(), equals(WorkspaceTask().abstractions)), Ensure.that(WorkspaceTests(), equals(WorkspaceTask().tests)),
    Ensure.that(WorldWorkspacePage.resolve.isEnabled(), equals(false)),
  ),
  ConfirmWorkspaceOriginals(),
);

export const InspectWorldOperations = () => Task.where('#actor inspects session-only public operation receipts and a precise missing-key rejection without resuming or cancelling anything',
  Click.on(WorldWorkspacePage.settingsNavigation), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.settingsHeading, isVisible()), ready(),
  Click.on(WorldWorkspacePage.operationsTab), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.session, isEnabled()),
  Ensure.that(WorldWorkspacePage.scopeNotice, isVisible()), ReadWorkspaceSession(),
  Ensure.that(WorkspaceSessionValues(), equals(WorkspaceSession().ids)),
  Ensure.that(WorkspaceTrackedCount(), equals(WorkspaceSessionCount().as(String))),
  Check.whether(WorkspaceSessionCount(), isGreaterThan(0)).andIfSo(
    Select.value(WorkspaceSession().first).from(WorldWorkspacePage.session),
    Wait.upTo(Duration.ofSeconds(45)).until(WorkspaceOperationSettled(), equals(true)),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.result, isEnabled()), Click.on(WorldWorkspacePage.result),
    Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.result, isEnabled()), ReadWorkspaceOperation(),
  ).otherwise(
    Ensure.that(WorldWorkspacePage.noTracked, isVisible()), Ensure.that(WorldWorkspacePage.resultSections.count(), equals(0)),
    Ensure.that(WorldWorkspacePage.tracePhases.count(), equals(0)),
  ),
  Click.on(WorldWorkspacePage.historySummary), Enter.theValue(WorkspaceSession().missing).into(WorldWorkspacePage.operationId),
  Click.on(WorldWorkspacePage.lookup), ReadMissingWorkspaceOperation(),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.operationErrors.count(), equals(1)),
  Ensure.that(WorkspaceOperationErrorTexts(), equals(WorkspaceMissing().message.as(message => [message]))),
  Ensure.that(WorldWorkspacePage.resultSections.count(), equals(0)), Ensure.that(WorldWorkspacePage.tracePhases.count(), equals(0)),
  ConfirmWorkspaceOriginals(),
);

export const InspectWorldWriteGates = () => Task.where('#actor leaves IDs empty or whitespace and confirms material and authoring prerequisites prevent writes even after the original Task is selected',
  Click.on(WorldWorkspacePage.worldSelector), Enter.theValue('').into(WorldWorkspacePage.tenant), Enter.theValue('').into(WorldWorkspacePage.world),
  Ensure.that(WorldWorkspacePage.open.isEnabled(), equals(false)),
  Enter.theValue('   ').into(WorldWorkspacePage.tenant), Enter.theValue('   ').into(WorldWorkspacePage.world),
  Ensure.that(WorldWorkspacePage.open.isEnabled(), equals(false)),
  Enter.theValue('local').into(WorldWorkspacePage.tenant), Enter.theValue('personal').into(WorldWorkspacePage.world),
  Click.on(WorldWorkspacePage.worldSelector), ready(),
  Click.on(WorldWorkspacePage.dataNavigation), Click.on(WorldWorkspacePage.materialsTab), Click.on(WorldWorkspacePage.upload),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.materialScope, isVisible()),
  Ensure.that(MaterialPolicySelections(), equals(['', '', ''])), Ensure.that(WorldWorkspacePage.materialFile.isEnabled(), equals(false)),
  Click.on(WorldWorkspacePage.modelNavigation), Click.on(WorldWorkspacePage.authoringTab), ReadWorkspaceTask(),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.authoringFile, isEnabled()),
  Select.value(WorkspaceTask().scope).from(WorldWorkspacePage.authoringScope), ReachOriginalWorkspaceTask('authoring'),
  Select.value(WorkspaceTask().authoringValue).from(WorldWorkspacePage.authoringTask),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.targetLock, isEnabled()),
  Ensure.that(WorkspaceOriginalAuthoringSelected(), equals(true)), Click.on(WorldWorkspacePage.confirm),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.confirmations.count(), equals(1)),
  Ensure.that(WorldWorkspacePage.previews.count(), equals(0)), Ensure.that(WorldWorkspacePage.submit.isEnabled(), equals(false)),
  Enter.theValue('   ').into(WorldWorkspacePage.noOpReason), Ensure.that(WorldWorkspacePage.submit.isEnabled(), equals(false)),
  Enter.theValue('').into(WorldWorkspacePage.noOpReason), ConfirmWorkspaceOriginals(),
);

export const LeaveWorldWorkspace = () => Task.where('#actor leaves World normally so all owned local forms, selections and lookup polling are unmounted without a mutation',
  StartAtSignIn(), EnterChat(), Wait.upTo(Duration.ofSeconds(15)).until(WorkspaceLeft(), equals(true)),
);
