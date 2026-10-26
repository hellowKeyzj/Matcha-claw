import { Interaction, notes } from '@serenity-js/core';
import { SessionCatalog } from '../abilities/session-catalog.ability.js';

export const RememberPublicCatalog = () => Interaction.where('#actor records complete identities before selecting a new draft', async actor => {
  const catalog = actor.abilityTo(SessionCatalog);
  await catalog.rememberCatalog();
});

export const CompareDraftCatalog = () => Interaction.where('#actor reads the native catalog after selecting the UI draft', async actor => {
  const unchanged = await actor.abilityTo(SessionCatalog).draftDidNotCreateSession();
  await notes<{ sessionCatalogDraftUnchanged: boolean }>().set('sessionCatalogDraftUnchanged', unchanged).performAs(actor);
});

export const ExerciseIndependentCatalogSession = () => Interaction.where('#actor creates, lists, reads and precisely deletes only its independent session', async actor => {
  const receipt = await actor.abilityTo(SessionCatalog).verifyIndependentSession();
  await notes<{ sessionCatalogReceipt: typeof receipt }>().set('sessionCatalogReceipt', receipt).performAs(actor);
});
