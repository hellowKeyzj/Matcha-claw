import { Interaction, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { TeamLifecycle } from '../abilities/team-lifecycle.ability.js';
import { TeamLifecyclePage } from '../pages/team-lifecycle.page.js';

export const ReviewTeamLifecycleSkill = () => Interaction.where('#actor reviews the operator-trusted TeamSkill through public Host selection', async actor => {
  const review = await actor.abilityTo(TeamLifecycle).reviewTrustedSkill();
  await notes().set('teamLifecycleReview', review).performAs(actor);
});

export const ReserveTeamLifecycle = () => Interaction.where('#actor reserves a UUID display name and remembers the untouched UI Team collection', async actor => {
  const resource = await actor.abilityTo(TeamLifecycle).reserve(await actor.answer(Text.ofAll(TeamLifecyclePage.teamNames)));
  await notes().set('teamLifecycleResource', resource).performAs(actor);
});

export const CompleteTeamSkillPicker = () => Interaction.where('#actor selects only the explicitly trusted directory in the owned native picker', async actor => {
  await actor.abilityTo(TeamLifecycle).completePicker();
});

export const ConfirmTeamSkillUiReview = () => Interaction.where('#actor accepts only a fresh create review with ready dependencies, never open-existing or replace', async actor => {
  if (await actor.answer(TeamLifecyclePage.existingTeam.isPresent()) || await actor.answer(TeamLifecyclePage.replaceTeam.isPresent())) {
    throw new Error('Precondition: this TeamSkill already has a Team; no existing Team was opened or replaced');
  }
  actor.abilityTo(TeamLifecycle).confirmReview(
    await actor.answer(Text.of(TeamLifecyclePage.selectedPath)),
    await actor.answer(Text.of(TeamLifecyclePage.packageIdentity)),
    await actor.answer(Text.of(TeamLifecyclePage.dependencies)),
    await actor.answer(Text.of(TeamLifecyclePage.create)),
  );
});

export const ArmTeamLifecycleMutation = (operation: 'create-team' | 'purge-run' | 'delete-team') =>
  Interaction.where(`#actor records ${operation} as pending before the single UI click`, async actor => {
    const uiRunId = operation === 'purge-run'
      ? await actor.answer(Attribute.called('title').of(TeamLifecyclePage.runHistory)) : undefined;
    await actor.abilityTo(TeamLifecycle).arm(operation, uiRunId);
  });

export const ConfirmUiCreatedTeam = () => Interaction.where('#actor binds the exact new UI Team/run to same-call provisioning and native graph facts', async actor => {
  const resource = await actor.answer(notes<{ teamLifecycleResource: { name: string } }>().get('teamLifecycleResource'));
  const ownership = await actor.abilityTo(TeamLifecycle).confirmCreated(
    await actor.answer(Text.of(TeamLifecyclePage.detailHeading(resource.name))),
    await actor.answer(Attribute.called('title').of(TeamLifecyclePage.runHistory)),
  );
  await notes().set('teamLifecycleOwnership', ownership).performAs(actor);
});

export const ConfirmTeamLifecycleMutation = () => Interaction.where('#actor observes only the exact pending UI mutation call and required terminal facts', async actor => {
  await actor.abilityTo(TeamLifecycle).reconcilePendingMutation();
});

export const ConfirmTeamCollection = (ownTeamPresent: boolean) => Interaction.where('#actor checks exact own membership and an unchanged foreign Team collection', async actor => {
  actor.abilityTo(TeamLifecycle).confirmOtherTeams(await actor.answer(Text.ofAll(TeamLifecyclePage.teamNames)), ownTeamPresent);
});

export const PrepareTeamLifecycleCleanup = () => Interaction.where('#actor reconciles pending results read-only and permits cleanup only of confirmed own resources', async actor => {
  const cleanup = await actor.abilityTo(TeamLifecycle).prepareCleanup();
  await notes().set('teamLifecycleCleanup', cleanup).performAs(actor);
});

export const RecordTeamLifecycleResult = () => Interaction.where('#actor records the observed UI lifecycle without claiming model execution or unavailable cancellation', async actor => {
  await notes().set('teamLifecycleResult', actor.abilityTo(TeamLifecycle).result()).performAs(actor);
});
