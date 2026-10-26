import { Interaction, notes } from '@serenity-js/core';
import { WorldSources } from '../abilities/world-sources.ability.js';

export const PrepareWorldSourceConnections = () => Interaction.where('#actor configures two owned loopback HTTP sources through normal UI and retains each exact original connection receipt, without treating configuration as schema discovery or synchronization', async actor => {
  const ability = actor.abilityTo(WorldSources);
  let primaryFailure: unknown;
  try { await ability.setupConnections(); }
  catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await notes().set('worldSourceSetup', ability.setupEvidence()).performAs(actor); }
    catch (error) { throw new AggregateError(primaryFailure === undefined ? [error] : [primaryFailure, error], 'Source setup original failure and evidence failure retained'); }
  }
});

export const BindWorldSourceOriginals = () => Interaction.where('#actor binds only explicit public Source originals and separate real read/discovery/sync permissions before any Source access', async actor => {
  await notes().set('worldSourcesInput', await actor.abilityTo(WorldSources).bindPublicInput()).performAs(actor);
});
export const ReadWorldSourcePrerequisites = () => Interaction.where('#actor reads exact published connections, scope, schemas, mappings and actual connector capabilities without granting or configuring anything', async actor => {
  await notes().set('worldSourcesPrerequisites', await actor.abilityTo(WorldSources).inspectPrerequisites()).performAs(actor);
});
export const MarkWorldSchemaDiscovery = () => Interaction.where('#actor observes the one forthcoming normal UI schema discovery without intercepting its request', async actor => {
  await actor.abilityTo(WorldSources).markCommand('discover');
});
export const ConfirmWorldSchemaDiscovery = () => Interaction.where('#actor verifies the original observed schema operation and its complete independent readback, not merely configuration or acceptance', async actor => {
  await notes().set('worldSourcesDiscovery', await actor.abilityTo(WorldSources).confirmCommand('discover')).performAs(actor);
});
export const MarkWorldSourceSynchronization = () => Interaction.where('#actor fences one UI one-shot synchronization and observes its real public operation hints', async actor => {
  await actor.abilityTo(WorldSources).markCommand('sync');
});
export const ConfirmWorldSourceSynchronization = () => Interaction.where('#actor verifies the same completed sync operation, new epoch and all four actual Source cursor frontiers', async actor => {
  await notes().set('worldSourcesSynchronization', await actor.abilityTo(WorldSources).confirmCommand('sync')).performAs(actor);
});
export const ReadWorldSourceCheckpoint = () => Interaction.where('#actor independently reads only the exact original completed synchronization checkpoint', async actor => {
  await notes().set('worldSourcesCheckpoint', await actor.abilityTo(WorldSources).readCheckpoint()).performAs(actor);
});
export const ReadWorldSourceObjectRows = () => Interaction.where('#actor reads only the actual normal UI object IDs and rendered field columns, without intercepting transport or replaying a query', async actor => {
  await actor.abilityTo(WorldSources).readUiObjectRows();
});
export const ConfirmWorldSourceQuery = () => Interaction.where('#actor reads the complete original UI receipt and rendered objects, then verifies a separate public After page against its oracle and the original cursor/snapshot basis', async actor => {
  await notes().set('worldSourcesQuery', await actor.abilityTo(WorldSources).confirmUiQuery()).performAs(actor);
});
export const ReleaseWorldSourceObservations = () => Interaction.where('#actor releases only owned read-only Source observations, preserving unknown mutations and all history', async actor => {
  await actor.abilityTo(WorldSources).releaseObservations();
});
