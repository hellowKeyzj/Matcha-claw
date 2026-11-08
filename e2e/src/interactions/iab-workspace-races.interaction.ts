import { Interaction, notes } from '@serenity-js/core';
import { IabWorkspaceRaces } from '../abilities/iab-workspace-races.ability.js';

export const ExerciseIabWorkspaceRace = (caseId: 10 | 11 | 12, iteration: number) => Interaction.where(
  `#actor verifies the actual ordering of IAB race ${caseId}, iteration ${iteration}`,
  async actor => {
    await notes<{ iabWorkspaceRaceVerified: string }>().set('iabWorkspaceRaceVerified', '').performAs(actor);
    await actor.abilityTo(IabWorkspaceRaces).verify(caseId, iteration);
    await notes<{ iabWorkspaceRaceVerified: string }>().set('iabWorkspaceRaceVerified', `${caseId}:${iteration}`).performAs(actor);
  },
);
