import { Interaction, notes } from '@serenity-js/core';
import { IabBrowser } from '../abilities/iab-browser.ability.js';

export const ExerciseIabBrowser = () => Interaction.where('#actor checks every embedded browser feature in the owned Electron', async actor => {
  const summary = await actor.abilityTo(IabBrowser).verifyAll();
  await notes<{ iabSummary: { passed: number; failed: number } }>().set('iabSummary', summary).performAs(actor);
});
