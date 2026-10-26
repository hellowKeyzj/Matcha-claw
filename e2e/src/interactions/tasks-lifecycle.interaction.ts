import { Interaction, notes } from '@serenity-js/core';
import { TasksLifecycle } from '../abilities/tasks-lifecycle.ability.js';
import { TasksLifecyclePage } from '../pages/tasks-lifecycle.page.js';

export const PrepareTasksLifecycle = () => Interaction.where('#actor reserves unique task ownership', async actor => {
  await notes().set('tasksLifecyclePrivateMarker', actor.abilityTo(TasksLifecycle).privateMarker).performAs(actor);
});

export const RejectUnsafeTaskRequests = () => Interaction.where('#actor submits invalid public task requests', async actor => {
  await notes().set('tasksLifecycleRejections', await actor.abilityTo(TasksLifecycle).rejectUnsafeRequests()).performAs(actor);
});

export const BindLifecycleSession = () => Interaction.where('#actor binds one existing public OpenClaw main identity without fallback', async actor => {
  await actor.abilityTo(TasksLifecycle).selectExistingSession();
});

export const CreateOwnedLifecycleTask = () => Interaction.where('#actor submits public TaskCreate once because Task Center has no creation UI', async actor => {
  await notes().set('tasksLifecycleOwnedTask', await actor.abilityTo(TasksLifecycle).createOwnTask()).performAs(actor);
});

export const CompleteOwnedLifecycleTask = () => Interaction.where('#actor submits public completion once because Task Center has no completion UI', async actor => {
  await notes().set('tasksLifecycleCompleted', await actor.abilityTo(TasksLifecycle).completeOwnTask()).performAs(actor);
});

export const RejectUnsafeLifecycleUpdate = () => Interaction.where('#actor submits an invalid update of the exact completed task', async actor => {
  await notes().set('tasksLifecycleUpdateRejection', await actor.abilityTo(TasksLifecycle).rejectUnsafeUpdate()).performAs(actor);
});

export const ScrollTaskDirectory = (reset = false) => Interaction.where('#actor scrolls the current task directory viewport', async actor => {
  await actor.abilityTo(TasksLifecycle).scrollDirectory(TasksLifecyclePage.directorySelector, reset);
});

export const MarkLifecycleDelete = () => Interaction.where('#actor fences the single UI deletion submission', async actor => {
  actor.abilityTo(TasksLifecycle).markDeleteSubmitted();
});

export const ConfirmLifecycleDeletion = () => Interaction.where('#actor independently reads the UI-deleted task absence', async actor => {
  await notes().set('tasksLifecycleDeleted', await actor.abilityTo(TasksLifecycle).confirmOwnTaskIsAbsent()).performAs(actor);
});

export const FindLifecycleCleanupTarget = () => Interaction.where('#actor reads only the settled exact owned task for UI cleanup', async actor => {
  const target = await actor.abilityTo(TasksLifecycle).cleanupTarget();
  await notes().set('tasksLifecycleCleanupTarget', Boolean(target)).performAs(actor);
  if (target) await notes().set('tasksLifecycleOwnedTask', target).performAs(actor);
});
