import { Ensure, equals, isLessThan } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait, notes } from '@serenity-js/core';
import { Attribute, Click, Enter, isEnabled, isVisible } from '@serenity-js/web';
import {
  ArmScheduledTaskTrigger, ConfirmScheduledTaskDeletion, FindScheduledTaskCleanupTarget,
  MarkScheduledTaskSubmission, ObserveCreatedScheduledTask, ObserveScheduledTask, ObserveScheduledTaskExecution,
  PrepareScheduledTask, ReadScheduledTaskRoute, RememberScheduledTaskBaseline, RequireScheduledExecutionPrerequisites,
  SendMalformedScheduledTaskTrigger, VisitLegacyCronRoute,
} from '../interactions/scheduled-tasks.interaction.js';
import { ChatPage } from '../pages/chat.page.js';
import { ScheduledTasksPage } from '../pages/scheduled-tasks.page.js';
import {
  OwnedScheduledTask, ScheduledTaskEditDate, ScheduledTaskEditMessage, ScheduledTaskEditName, ScheduledTaskEditTime,
  ScheduledTaskEnabledState, ScheduledTaskHasCleanupTarget, ScheduledTaskInput, ScheduledTaskMessage,
  ScheduledTaskOpenedOwnDialog, ScheduledTaskPreviousRuntime, ScheduledTaskRuntimeWasSaved, ScheduledTaskTabSelected,
  ScheduledTaskTitle,
} from '../questions/scheduled-tasks.question.js';
import { EnterChat } from './chat.task.js';

export const OpenScheduledTaskCenter = () => Task.where('#actor opens the current OpenClaw scheduled-task panel',
  Check.whether(ChatPage.switchboard, isVisible()).andIfSo(Click.on(ChatPage.switchboardBackdrop)),
  Click.on(ScheduledTasksPage.navigation),
  Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.tab, isVisible()), Click.on(ScheduledTasksPage.tab),
  Ensure.that(ScheduledTasksPage.dialogs.count(), equals(0)),
  Check.whether(ScheduledTasksPage.openClawChoice, isVisible()).andIfSo(
    Check.whether(ScheduledTaskRuntimeWasSaved(), equals(false)).andIfSo(
      notes().set('scheduledTaskRuntime', Attribute.called('aria-label').of(ScheduledTasksPage.selectedRuntime)),
    ),
    Click.on(ScheduledTasksPage.openClawChoice),
  ).otherwise(Ensure.that(ScheduledTasksPage.openClawOnly, isVisible())),
  Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.create, isEnabled()),
  Click.on(ScheduledTasksPage.all), Ensure.that(ScheduledTaskTabSelected(), equals('true')),
);

export const VisitScheduledTaskEntry = () => Task.where('#actor reaches the same scheduled panel through Task Center and the retained Cron redirect',
  EnterChat(), OpenScheduledTaskCenter(), ReadScheduledTaskRoute('entry'),
  VisitLegacyCronRoute(), Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTaskTabSelected(), equals('true')),
  Ensure.that(ScheduledTasksPage.create, isVisible()), ReadScheduledTaskRoute('legacy'),
);

export const CreateIndependentScheduledTask = (mode: 'manage' | 'trigger' = 'manage') => Task.where('#actor creates one far-future job through the current scheduled-task form',
  EnterChat(), PrepareScheduledTask(mode),
  ...(mode === 'trigger' ? [RequireScheduledExecutionPrerequisites()] : []),
  OpenScheduledTaskCenter(), RememberScheduledTaskBaseline(),
  Ensure.that(ScheduledTasksPage.dialogs.count(), equals(0)), notes().set('scheduledTaskOwnDialog', true),
  Click.on(ScheduledTasksPage.create), Wait.until(ScheduledTasksPage.createDialog, isVisible()),
  Ensure.that(ScheduledTasksPage.dialogs.count(), equals(1)),
  Enter.theValue(ScheduledTaskInput().initialName).into(ScheduledTasksPage.createName),
  Enter.theValue(ScheduledTaskInput().message).into(ScheduledTasksPage.createMessage),
  Click.on(ScheduledTasksPage.createOnce),
  Enter.theValue(ScheduledTaskInput().initialSchedule.date).into(ScheduledTasksPage.createDate),
  Enter.theValue(ScheduledTaskInput().initialSchedule.time).into(ScheduledTasksPage.createTime),
  Wait.until(ScheduledTasksPage.createSubmit, isEnabled()),
  MarkScheduledTaskSubmission('create'), Click.on(ScheduledTasksPage.createSubmit),
  Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.dialogs.count(), equals(0)),
  ObserveCreatedScheduledTask(),
  Wait.until(ScheduledTasksPage.card(OwnedScheduledTask().selector), isVisible()),
  Ensure.that(ScheduledTaskTitle(), equals(ScheduledTaskInput().initialName)),
  Ensure.that(ScheduledTaskMessage(), equals(ScheduledTaskInput().message)),
  Ensure.that(ScheduledTaskEnabledState(), equals('true')),
);

export const RefreshOwnedScheduledTask = () => Task.where('#actor refreshes the scheduled list and verifies the same persisted job',
  Wait.until(ScheduledTasksPage.refresh, isEnabled()), Click.on(ScheduledTasksPage.refresh),
  Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.refresh, isEnabled()),
  ObserveScheduledTask(false, true), Ensure.that(ScheduledTaskTitle(), equals(ScheduledTaskInput().initialName)),
  Ensure.that(ScheduledTaskMessage(), equals(ScheduledTaskInput().message)),
);

export const SetOwnedScheduledTaskEnabled = (enabled: boolean) => Task.where(`#actor ${enabled ? 'resumes' : 'pauses'} its exact scheduled job once`,
  Wait.until(ScheduledTasksPage.toggle(OwnedScheduledTask().selector), isEnabled()),
  Ensure.that(ScheduledTaskEnabledState(), equals(String(!enabled))),
  MarkScheduledTaskSubmission('toggle'), Click.on(ScheduledTasksPage.toggle(OwnedScheduledTask().selector)),
  Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTaskEnabledState(), equals(String(enabled))),
  ObserveScheduledTask(false, enabled),
);

export const EditOwnedScheduledTask = (mode: 'manage' | 'trigger' = 'manage') => Task.where('#actor edits the paused exact job using its existing form values',
  Ensure.that(ScheduledTaskEnabledState(), equals('false')),
  Wait.until(ScheduledTasksPage.edit(OwnedScheduledTask().selector), isEnabled()),
  Ensure.that(ScheduledTasksPage.dialogs.count(), equals(0)), notes().set('scheduledTaskOwnDialog', true),
  Click.on(ScheduledTasksPage.edit(OwnedScheduledTask().selector)), Wait.until(ScheduledTasksPage.editDialog, isVisible()),
  Ensure.that(ScheduledTasksPage.dialogs.count(), equals(1)),
  Ensure.that(ScheduledTaskEditName(), equals(ScheduledTaskInput().initialName)),
  Ensure.that(ScheduledTaskEditMessage(), equals(ScheduledTaskInput().message)),
  Ensure.that(ScheduledTaskEditDate(), equals(ScheduledTaskInput().initialSchedule.date)),
  Ensure.that(ScheduledTaskEditTime(), equals(ScheduledTaskInput().initialSchedule.time)),
  Enter.theValue(ScheduledTaskInput().updatedName).into(ScheduledTasksPage.editName),
  Enter.theValue(ScheduledTaskInput().updatedMessage).into(ScheduledTasksPage.editMessage),
  ...(mode === 'trigger' ? [
    Click.on(ScheduledTasksPage.editPeriodic), Click.on(ScheduledTasksPage.editCustom),
    Enter.theValue('0 0 29 2 *').into(ScheduledTasksPage.editCron),
  ] : [
    Enter.theValue(ScheduledTaskInput().updatedSchedule.date).into(ScheduledTasksPage.editDate),
    Enter.theValue(ScheduledTaskInput().updatedSchedule.time).into(ScheduledTasksPage.editTime),
  ]),
  Wait.until(ScheduledTasksPage.editSubmit, isEnabled()), MarkScheduledTaskSubmission('update'), Click.on(ScheduledTasksPage.editSubmit),
  Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.dialogs.count(), equals(0)),
  ObserveScheduledTask(true, false),
  Ensure.that(ScheduledTaskTitle(), equals(ScheduledTaskInput().updatedName)),
  Ensure.that(ScheduledTaskMessage(), equals(ScheduledTaskInput().updatedMessage)),
  Ensure.that(ScheduledTaskEnabledState(), equals('false')),
);

export const DeleteOwnedScheduledTask = () => Task.where('#actor deletes only its exact UUID-owned Cron card through the existing confirmation UI',
  Wait.until(ScheduledTasksPage.delete(OwnedScheduledTask().selector), isEnabled()),
  Ensure.that(ScheduledTasksPage.dialogs.count(), equals(0)), notes().set('scheduledTaskOwnDialog', true),
  Click.on(ScheduledTasksPage.delete(OwnedScheduledTask().selector)), Wait.until(ScheduledTasksPage.confirmation, isVisible()),
  Ensure.that(ScheduledTasksPage.dialogs.count(), equals(1)), Ensure.that(ScheduledTasksPage.deleteMessage, isVisible()),
  Wait.until(ScheduledTasksPage.confirmDelete, isEnabled()), MarkScheduledTaskSubmission('delete'), Click.on(ScheduledTasksPage.confirmDelete),
  Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.dialogs.count(), equals(0)), ConfirmScheduledTaskDeletion(),
  Ensure.eventually(ScheduledTasksPage.card(OwnedScheduledTask().selector).isVisible(), equals(false)),
);

export const TriggerOwnedScheduledTask = () => Task.where('#actor manually triggers its paused recurring job once and verifies native completion, not just admission',
  Wait.until(ScheduledTasksPage.trigger(OwnedScheduledTask().selector), isEnabled()),
  ArmScheduledTaskTrigger(), Click.on(ScheduledTasksPage.trigger(OwnedScheduledTask().selector)),
  ObserveScheduledTaskExecution(),
  Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.lastRun(OwnedScheduledTask().selector), isVisible()),
);

export const RejectPrivateMalformedScheduledTaskTrigger = () => Task.where('#actor checks fixed malformed-trigger rejection without reflecting private input',
  EnterChat(), SendMalformedScheduledTaskTrigger(),
);

export const DismissOwnedScheduledTaskDialog = () => Task.where('#actor cancels only its own single scheduled-task dialog without bypassing an overlay',
  Check.whether(ScheduledTaskOpenedOwnDialog(), equals(true)).andIfSo(
    Ensure.that(ScheduledTasksPage.dialogs.count(), isLessThan(2)),
    Check.whether(ScheduledTasksPage.createDialog, isVisible()).andIfSo(
      Ensure.that(ScheduledTasksPage.dialogs.count(), equals(1)),
      Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.createCancel, isEnabled()), Click.on(ScheduledTasksPage.createCancel),
    ),
    Check.whether(ScheduledTasksPage.editDialog, isVisible()).andIfSo(
      Ensure.that(ScheduledTasksPage.dialogs.count(), equals(1)),
      Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.editCancel, isEnabled()), Click.on(ScheduledTasksPage.editCancel),
    ),
    Check.whether(ScheduledTasksPage.confirmation, isVisible()).andIfSo(
      Ensure.that(ScheduledTasksPage.dialogs.count(), equals(1)),
      Wait.upTo(Duration.ofSeconds(45)).until(ScheduledTasksPage.cancelDelete, isEnabled()), Click.on(ScheduledTasksPage.cancelDelete),
    ),
  ),
);

export const CleanupScheduledTask = () => Task.where('#actor deletes only settled confirmed Cron ownership, never unknown submissions',
  FindScheduledTaskCleanupTarget(),
  Check.whether(ScheduledTaskHasCleanupTarget(), equals(true)).andIfSo(OpenScheduledTaskCenter(), DeleteOwnedScheduledTask()),
);

export const RestoreScheduledTaskRuntime = () => Task.where('#actor restores the management runtime changed by this case',
  Check.whether(ScheduledTaskRuntimeWasSaved(), equals(true)).andIfSo(
    Ensure.that(ScheduledTasksPage.dialogs.count(), equals(0)),
    Check.whether(ChatPage.switchboard, isVisible()).andIfSo(Click.on(ChatPage.switchboardBackdrop)),
    Click.on(ScheduledTasksPage.navigation), Wait.until(ScheduledTasksPage.tab, isVisible()),
    Click.on(ScheduledTasksPage.runtime(ScheduledTaskPreviousRuntime())),
  ),
);
