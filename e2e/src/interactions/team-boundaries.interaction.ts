import { Interaction, Wait, notes } from '@serenity-js/core';
import { equals } from '@serenity-js/assertions';
import { Click, Text } from '@serenity-js/web';
import { UseTeamBoundaries } from '../abilities/team-boundaries.ability.js';
import { TeamBoundariesPage } from '../pages/team-boundaries.page.js';

export const PrepareInvalidTeamSkill = () => Interaction.where('#actor prepares its own non-executable invalid TeamSkill', async actor => {
  await actor.abilityTo(UseTeamBoundaries).prepareInvalidPackage();
});

export const ValidateInvalidTeamSkill = () => Interaction.where('#actor validates a temporary invalid TeamSkill through the public Renderer IPC', async actor => {
  const receipt = await actor.abilityTo(UseTeamBoundaries).validateInvalidPackage();
  await notes<{ invalidTeamSkillReceipt: typeof receipt }>().set('invalidTeamSkillReceipt', receipt).performAs(actor);
});

export const RememberOriginalTeams = () => Interaction.where('#actor remembers the existing Team collection without recording its contents', async actor => {
  actor.abilityTo(UseTeamBoundaries).rememberTeamList(await actor.answer(Text.ofAll(TeamBoundariesPage.teamNames)));
});

export const OpenTeamBoundaryDialog = () => Interaction.where('#actor opens its own Team creation dialog', async actor => {
  actor.abilityTo(UseTeamBoundaries).createDialogOpeningAttempted = true;
  await Click.on(TeamBoundariesPage.openCreate).performAs(actor);
});

export const CompleteInvalidTeamSkillPicker = () => Interaction.where('#actor selects its own invalid TeamSkill in the real native directory picker', async actor => {
  await actor.abilityTo(UseTeamBoundaries).completeInvalidPackagePicker();
});

export const CompareOriginalTeams = () => Interaction.where('#actor compares the original Team collection without recording its contents', async actor => {
  const unchanged = actor.abilityTo(UseTeamBoundaries).isTeamListUnchanged(await actor.answer(Text.ofAll(TeamBoundariesPage.teamNames)));
  await notes<{ originalTeamsUnchanged: boolean }>().set('originalTeamsUnchanged', unchanged).performAs(actor);
});

export const DismissTeamBoundaryDialog = () => Interaction.where('#actor restores only its own Team creation dialog if it remains open', async actor => {
  const ability = actor.abilityTo(UseTeamBoundaries);
  if (!ability.createDialogOpeningAttempted) return;
  if (await actor.answer(TeamBoundariesPage.createDialog.isVisible())) {
    await Click.on(TeamBoundariesPage.cancel).performAs(actor);
    await Wait.until(TeamBoundariesPage.createDialog.isVisible(), equals(false)).performAs(actor);
  }
  ability.createDialogOpeningAttempted = false;
});

export const RemoveInvalidTeamSkill = () => Interaction.where('#actor removes only its own temporary invalid TeamSkill directory', async actor => {
  await actor.abilityTo(UseTeamBoundaries).removeInvalidPackage();
});

export const SubmitMismatchedTeamSkillTarget = () => Interaction.where('#actor submits a mismatched TeamSkill target to the Electron boundary', async actor => {
  const receipt = await actor.abilityTo(UseTeamBoundaries).rejectMismatchedPackageTarget();
  await notes<{ electronTeamBoundaryReceipt: typeof receipt }>().set('electronTeamBoundaryReceipt', receipt).performAs(actor);
});

export const SubmitAdditionalTeamSkillInput = () => Interaction.where('#actor submits an extra TeamSkill input field to the Rust boundary', async actor => {
  const receipt = await actor.abilityTo(UseTeamBoundaries).rejectAdditionalPackageInput();
  await notes<{ rustTeamBoundaryReceipt: typeof receipt }>().set('rustTeamBoundaryReceipt', receipt).performAs(actor);
});
