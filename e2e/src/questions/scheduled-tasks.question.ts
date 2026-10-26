import { Question, notes } from '@serenity-js/core';
import { Attribute, Text, Value } from '@serenity-js/web';
import { ScheduledTasksPage } from '../pages/scheduled-tasks.page.js';

type ScheduledTaskNotes = {
  scheduledTaskInput: {
    initialName: string; updatedName: string; message: string; updatedMessage: string;
    initialSchedule: { date: string; time: string; at: string };
    updatedSchedule: { date: string; time: string; at: string };
  };
  scheduledTaskOwned: { id: string; selector: string };
  scheduledTaskReadbackMatches: boolean;
  scheduledTaskDeleted: boolean;
  scheduledTaskCleanupTarget: boolean;
  scheduledTaskRuntime: string;
  scheduledTaskOwnDialog: boolean;
  scheduledTaskEntryRoute: string;
  scheduledTaskLegacyRoute: string;
  scheduledTaskExecution: { admitted: boolean; sameCallSettled: boolean; sameJobNativeSucceeded: boolean; hasRunId: boolean };
  scheduledTaskRejection: {
    transportOk: boolean; status: number | null; httpOk: boolean | null;
    fixedRejection: boolean; privateInputReflected: boolean; privateFieldExposed: boolean;
  };
};

export const ScheduledTaskInput = () => notes<ScheduledTaskNotes>().get('scheduledTaskInput');
export const OwnedScheduledTask = () => notes<ScheduledTaskNotes>().get('scheduledTaskOwned');
export const ScheduledTaskReadbackMatches = () => notes<ScheduledTaskNotes>().get('scheduledTaskReadbackMatches');
export const ScheduledTaskDeletionWasConfirmed = () => notes<ScheduledTaskNotes>().get('scheduledTaskDeleted');
export const ScheduledTaskHasCleanupTarget = () => notes<ScheduledTaskNotes>().get('scheduledTaskCleanupTarget');
export const ScheduledTaskRuntimeWasSaved = () => notes<ScheduledTaskNotes>().has('scheduledTaskRuntime');
export const ScheduledTaskPreviousRuntime = () => notes<ScheduledTaskNotes>().get('scheduledTaskRuntime');
export const ScheduledTaskOpenedOwnDialog = () => notes<ScheduledTaskNotes>().has('scheduledTaskOwnDialog');
export const ScheduledTaskTitle = () => Text.of(ScheduledTasksPage.title(OwnedScheduledTask().selector));
export const ScheduledTaskMessage = () => Text.of(ScheduledTasksPage.message(OwnedScheduledTask().selector));
export const ScheduledTaskEnabledState = () => Attribute.called('aria-checked').of(ScheduledTasksPage.toggle(OwnedScheduledTask().selector));
export const ScheduledTaskCardIsVisible = () => ScheduledTasksPage.card(OwnedScheduledTask().selector).isVisible();
export const ScheduledTaskTabSelected = () => Attribute.called('aria-selected').of(ScheduledTasksPage.tab);
export const ScheduledTaskEditName = () => Value.of(ScheduledTasksPage.editName);
export const ScheduledTaskEditMessage = () => Value.of(ScheduledTasksPage.editMessage);
export const ScheduledTaskEditDate = () => Value.of(ScheduledTasksPage.editDate);
export const ScheduledTaskEditTime = () => Question.about('the scheduled-task edit time at whole-second precision', async actor => {
  const value = await actor.answer(Value.of(ScheduledTasksPage.editTime));
  return value.length === 5 ? `${value}:00` : value.replace(/\.000$/, '');
});
export const ScheduledTaskEntry = () => Question.about('the current entry and retained legacy route use the scheduled Task Center panel', async actor => ({
  entryRoute: await actor.answer(notes<ScheduledTaskNotes>().get('scheduledTaskEntryRoute')),
  entryVisible: await actor.answer(ScheduledTasksPage.create.isVisible()),
  legacyRoute: await actor.answer(notes<ScheduledTaskNotes>().get('scheduledTaskLegacyRoute')),
  scheduledTabSelected: await actor.answer(ScheduledTaskTabSelected()) === 'true',
  legacyConsumerVisible: await actor.answer(ScheduledTasksPage.panel.isVisible()),
}));
export const ScheduledTaskTriggerRejection = () => notes<ScheduledTaskNotes>().get('scheduledTaskRejection');
export const ScheduledTaskExecution = () => notes<ScheduledTaskNotes>().get('scheduledTaskExecution');
