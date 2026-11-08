import { Interaction, notes } from '@serenity-js/core';
import { IabAgent } from '../abilities/iab-agent.ability.js';

export const ExerciseIabAgent = (scenario: 'multi-step' | 'simple' | 'complex' | 'parallel' | 'subagents' | 'stress' = 'multi-step') => Interaction.where(`#actor verifies real Agent browser operation: ${scenario}`, async actor => {
  const verified = await actor.abilityTo(IabAgent).verify(scenario);
  await notes<{ iabAgentVerified: boolean }>().set('iabAgentVerified', verified).performAs(actor);
});
