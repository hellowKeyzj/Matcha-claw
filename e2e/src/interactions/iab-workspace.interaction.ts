import { Interaction, notes } from '@serenity-js/core';
import { IabWorkspace } from '../abilities/iab-workspace.ability.js';

export const ExerciseIabWorkspace = (caseId: number) => Interaction.where(
  `#actor verifies IAB workspace case ${caseId} and restores the original scene`,
  async actor => {
    await notes<{ iabWorkspaceVerified: number }>().set('iabWorkspaceVerified', 0).performAs(actor);
    await actor.abilityTo(IabWorkspace).verify(caseId);
    await notes<{ iabWorkspaceVerified: number }>().set('iabWorkspaceVerified', caseId).performAs(actor);
  },
);
