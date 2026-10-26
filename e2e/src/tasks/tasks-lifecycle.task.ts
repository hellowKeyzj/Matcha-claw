import { Ensure, equals } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait, notes } from '@serenity-js/core';
import type { AnswersQuestions } from '@serenity-js/core';
import { Attribute, Click, Select, isEnabled, isVisible } from '@serenity-js/web';
import {
  BindLifecycleSession, CompleteOwnedLifecycleTask, ConfirmLifecycleDeletion, CreateOwnedLifecycleTask,
  FindLifecycleCleanupTarget, MarkLifecycleDelete, PrepareTasksLifecycle, RejectUnsafeLifecycleUpdate,
  RejectUnsafeTaskRequests, ScrollTaskDirectory,
} from '../interactions/tasks-lifecycle.interaction.js';
import { ChatPage } from '../pages/chat.page.js';
import { TasksLifecyclePage } from '../pages/tasks-lifecycle.page.js';
import {
  LifecycleHasCleanupTarget, LifecycleOpenedOwnDialog, LifecyclePreviousRuntime, LifecycleRuntimeWasSaved, OwnedLifecycleTask,
  OwnedTaskTitleIsVisible, TaskCenterOwnedId,
} from '../questions/tasks-lifecycle.question.js';

export const PrepareTaskLifecycle = () => Task.where('#actor prepares isolated task ownership', PrepareTasksLifecycle());
export const CheckInvalidTaskPrivacy = () => Task.where('#actor checks public task validation and safe errors', RejectUnsafeTaskRequests());
export const CreateLifecycleTask = () => Task.where('#actor creates a real task through the public seam absent from the UI',
  BindLifecycleSession(), CreateOwnedLifecycleTask(),
);
export const CompleteLifecycleTask = () => Task.where('#actor completes its exact task through the public seam absent from the UI', CompleteOwnedLifecycleTask());
export const CheckInvalidLifecycleUpdate = () => Task.where('#actor checks invalid update without changing its completed task', RejectUnsafeLifecycleUpdate());

export const OpenTaskCenterDirectory = () => Task.where('#actor opens the OpenClaw main Agent long-task directory',
  Check.whether(ChatPage.switchboard, isVisible()).andIfSo(Click.on(ChatPage.switchboardBackdrop)),
  Click.on(TasksLifecyclePage.navigation),
  Wait.upTo(Duration.ofSeconds(45)).until(TasksLifecyclePage.longTasksTab, isVisible()),
  Click.on(TasksLifecyclePage.longTasksTab),
  Ensure.that(TasksLifecyclePage.dialogs.count(), equals(0)),
  Check.whether(TasksLifecyclePage.openClawChoice, isVisible()).andIfSo(
    Check.whether(LifecycleRuntimeWasSaved(), equals(false)).andIfSo(
      notes().set('tasksLifecycleRuntime', Attribute.called('aria-label').of(TasksLifecyclePage.selectedRuntime)),
    ),
    Click.on(TasksLifecyclePage.openClawChoice),
  ).otherwise(Ensure.that(TasksLifecyclePage.openClawOnly, isVisible())),
  Wait.upTo(Duration.ofSeconds(45)).until(TasksLifecyclePage.refresh, isEnabled()),
  Select.value('agent:main').from(TasksLifecyclePage.scope),
  Select.value('all').from(TasksLifecyclePage.timeRange),
  Click.on(TasksLifecyclePage.all),
  Click.on(TasksLifecyclePage.refresh),
);

class FindOwnedTask extends Task {
  constructor() { super('#actor reveals the exact owned title in the paged or virtual task directory'); }
  async performAs(actor: Parameters<Task['performAs']>[0] & AnswersQuestions): Promise<void> {
    await actor.attemptsTo(Wait.upTo(Duration.ofSeconds(45)).until(TasksLifecyclePage.directory, isVisible()), ScrollTaskDirectory(true));
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !await actor.answer(OwnedTaskTitleIsVisible())) {
      await actor.attemptsTo(
        Check.whether(TasksLifecyclePage.loadMore, isVisible()).andIfSo(Click.on(TasksLifecyclePage.loadMore)),
        ScrollTaskDirectory(), Wait.for(Duration.ofMilliseconds(100)),
      );
    }
    await actor.attemptsTo(Ensure.that(OwnedTaskTitleIsVisible(), equals(true)));
  }
}

export const OpenOwnedTaskDetail = () => Task.where('#actor opens only its unique task and verifies its exact ID',
  new FindOwnedTask(), Click.on(TasksLifecyclePage.row(OwnedLifecycleTask().subject)),
  Wait.upTo(Duration.ofSeconds(45)).until(TaskCenterOwnedId(), equals(OwnedLifecycleTask().id)),
);

export const DeleteLifecycleTaskThroughUi = () => Task.where('#actor deletes the exact confirmed task once through Task Center',
  Ensure.that(TaskCenterOwnedId(), equals(OwnedLifecycleTask().id)),
  Ensure.that(TasksLifecyclePage.dialogs.count(), equals(0)),
  notes().set('tasksLifecycleOwnDialog', true), Click.on(TasksLifecyclePage.deleteTask(OwnedLifecycleTask().subject)),
  Wait.until(TasksLifecyclePage.deleteDialog, isVisible()),
  Ensure.that(TasksLifecyclePage.dialogs.count(), equals(1)),
  MarkLifecycleDelete(), Click.on(TasksLifecyclePage.confirmDelete),
  Wait.upTo(Duration.ofSeconds(45)).until(TasksLifecyclePage.deleteDialog.isVisible(), equals(false)),
  ConfirmLifecycleDeletion(),
);

export const CleanupTaskLifecycle = () => Task.where('#actor cleans only settled exact ownership through the existing deletion UI',
  Check.whether(LifecycleOpenedOwnDialog(), equals(true)).andIfSo(
    Check.whether(TasksLifecyclePage.deleteDialog, isVisible()).andIfSo(
      Ensure.that(TasksLifecyclePage.dialogs.count(), equals(1)),
      Wait.upTo(Duration.ofSeconds(45)).until(TasksLifecyclePage.cancelDelete, isEnabled()), Click.on(TasksLifecyclePage.cancelDelete),
    ),
  ),
  FindLifecycleCleanupTarget(),
  Check.whether(LifecycleHasCleanupTarget(), equals(true)).andIfSo(
    OpenTaskCenterDirectory(), OpenOwnedTaskDetail(), DeleteLifecycleTaskThroughUi(),
  ),
);

export const RestoreLifecycleRuntime = () => Task.where('#actor restores only the changed management runtime',
  Check.whether(LifecycleRuntimeWasSaved(), equals(true)).andIfSo(
    Check.whether(ChatPage.switchboard, isVisible()).andIfSo(Click.on(ChatPage.switchboardBackdrop)),
    Click.on(TasksLifecyclePage.navigation), Wait.until(TasksLifecyclePage.longTasksTab, isVisible()),
    Ensure.that(TasksLifecyclePage.dialogs.count(), equals(0)),
    Click.on(TasksLifecyclePage.runtime(LifecyclePreviousRuntime())),
  ),
);
