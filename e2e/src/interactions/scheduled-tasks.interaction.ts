import { Interaction, notes } from '@serenity-js/core';
import { ScheduledTasks } from '../abilities/scheduled-tasks.ability.js';

export const PrepareScheduledTask = (mode: 'manage' | 'trigger') => Interaction.where('#actor reserves one independent scheduled-task UUID', async actor => {
  await notes().set('scheduledTaskInput', await actor.abilityTo(ScheduledTasks).prepare(mode)).performAs(actor);
});

export const RememberScheduledTaskBaseline = () => Interaction.where('#actor reads the authoritative pre-creation Cron IDs', async actor => {
  await actor.abilityTo(ScheduledTasks).rememberBaseline();
});

export const MarkScheduledTaskSubmission = (operation: 'create' | 'update' | 'toggle' | 'delete') => Interaction.where(`#actor fences one UI Cron ${operation} submission`, async actor => {
  actor.abilityTo(ScheduledTasks).markSubmission(operation);
});

export const ObserveCreatedScheduledTask = () => Interaction.where('#actor binds the exact newly created UUID-owned Cron ID from public readback', async actor => {
  await notes().set('scheduledTaskOwned', await actor.abilityTo(ScheduledTasks).observeCreated()).performAs(actor);
});

export const ObserveScheduledTask = (updated: boolean, enabled: boolean) => Interaction.where('#actor verifies the exact job schedule, delivery, message and enabled state independently', async actor => {
  await notes().set('scheduledTaskReadbackMatches', await actor.abilityTo(ScheduledTasks).observeJob(updated, enabled)).performAs(actor);
});

export const ConfirmScheduledTaskDeletion = () => Interaction.where('#actor verifies the UI-deleted exact Cron ID is absent', async actor => {
  await notes().set('scheduledTaskDeleted', await actor.abilityTo(ScheduledTasks).confirmDeleted()).performAs(actor);
});

export const FindScheduledTaskCleanupTarget = () => Interaction.where('#actor reads only settled exact UUID ownership for UI cleanup', async actor => {
  const target = await actor.abilityTo(ScheduledTasks).cleanupTarget();
  await notes().set('scheduledTaskCleanupTarget', Boolean(target)).performAs(actor);
  if (target) await notes().set('scheduledTaskOwned', target).performAs(actor);
});

export const ReadScheduledTaskRoute = (kind: 'entry' | 'legacy') => Interaction.where('#actor reads the current task-center route', async actor => {
  await notes().set(kind === 'entry' ? 'scheduledTaskEntryRoute' : 'scheduledTaskLegacyRoute', actor.abilityTo(ScheduledTasks).route()).performAs(actor);
});

export const VisitLegacyCronRoute = () => Interaction.where('#actor visits the retained public Cron route', async actor => {
  await actor.abilityTo(ScheduledTasks).visitLegacyRoute();
});

export const SendMalformedScheduledTaskTrigger = () => Interaction.where('#actor submits an invalid trigger rejected before native execution', async actor => {
  await notes().set('scheduledTaskRejection', await actor.abilityTo(ScheduledTasks).rejectMalformedTrigger()).performAs(actor);
});

export const RequireScheduledExecutionPrerequisites = () => Interaction.where('#actor checks existing public runtime and model readiness without configuring either', async actor => {
  await actor.abilityTo(ScheduledTasks).requirePublicExecutionPrerequisites();
});

export const ArmScheduledTaskTrigger = () => Interaction.where('#actor fences its sole manual trigger after proving no prior call exists', async actor => {
  await actor.abilityTo(ScheduledTasks).armTrigger();
});

export const ObserveScheduledTaskExecution = () => Interaction.where('#actor observes the same trigger call and correlated native run reaching success', async actor => {
  await notes().set('scheduledTaskExecution', await actor.abilityTo(ScheduledTasks).observeNativeCompletion()).performAs(actor);
});
