import { Interaction, notes } from '@serenity-js/core';
import { WorldStorage } from '../abilities/world-storage.ability.js';

export const PrepareWorldStorage = () => Interaction.where('#actor classifies the dedicated storage fixture without replacing an existing baseline', async actor => {
  await notes().set('worldStoragePreparation', await actor.abilityTo(WorldStorage).prepare()).performAs(actor);
});
export const ConnectWorldStorage = () => Interaction.where('#actor connects through the visible password form inside the private recording boundary', async actor => {
  await actor.abilityTo(WorldStorage).connect();
});
export const ReadWorldStorageReady = () => Interaction.where('#actor reads the ready canonical World, complete authorization and all six directories', async actor => {
  await notes().set('worldStorageReady', await actor.abilityTo(WorldStorage).inspectReady()).performAs(actor);
});
export const ConfirmWorldStorageRepeated = () => Interaction.where('#actor confirms repeated connection preserves the exact World, storage, release and complete authorization', async actor => {
  await notes().set('worldStorageRepeated', await actor.abilityTo(WorldStorage).confirmRepeated()).performAs(actor);
});
