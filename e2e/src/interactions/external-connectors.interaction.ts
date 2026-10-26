import { Interaction, notes } from '@serenity-js/core';
import { Attribute } from '@serenity-js/web';
import { ExternalConnectors } from '../abilities/external-connectors.ability.js';
import { ExternalConnectorsPage } from '../pages/external-connectors.page.js';

export const ReserveExternalConnector = () => Interaction.where('#actor reserves a secret-free owned loopback connector after checking the public catalog', async actor => {
  const connectors = actor.abilityTo(ExternalConnectors);
  const resource = await connectors.reserve();
  await notes().set('externalConnectorResource', resource).performAs(actor);
});

export const RememberExternalConnectorRuntime = () => Interaction.where('#actor identifies the current management runtime without changing it', async actor => {
  const name = await actor.answer(Attribute.called('aria-label').of(ExternalConnectorsPage.selectedRuntime));
  if (!name) throw new Error('Connector management runtime has no public display name');
  await actor.abilityTo(ExternalConnectors).rememberRuntime(name);
  await notes().set('externalConnectorRuntimeName', name).performAs(actor);
});

export const ReadOriginalExternalConnectorRuntime = () => Interaction.where('#actor verifies the original ready endpoint before restoring its UI selection', async actor => {
  const name = await actor.abilityTo(ExternalConnectors).runtimeToRestore();
  await notes().set('externalConnectorRuntimeName', name).performAs(actor);
});

export const ArmExternalConnectorSubmission = (operation: 'rejection' | 'upsert' | 'probe' | 'remove') =>
  Interaction.where(`#actor records the single ${operation} submission before clicking`, async actor => {
    actor.abilityTo(ExternalConnectors).arm(operation);
  });

export const ReadRejectedConnectorAbsence = () => Interaction.where('#actor confirms the rejected connector has no public stored fact', async actor => {
  const absent = await actor.abilityTo(ExternalConnectors).confirmRejectedAbsent();
  await notes().set('externalConnectorRejectedAbsent', absent).performAs(actor);
});

export const ReadStoredConnector = () => Interaction.where('#actor reads the unique UI save call and exact public connector fact', async actor => {
  const receipt = await actor.abilityTo(ExternalConnectors).confirmStored();
  await notes().set('externalConnectorStored', receipt).performAs(actor);
});

export const ReadConnectorProbe = () => Interaction.where('#actor reads the unique UI probe call without issuing a second probe', async actor => {
  const receipt = await actor.abilityTo(ExternalConnectors).confirmProbed();
  await notes().set('externalConnectorProbe', receipt).performAs(actor);
});

export const CheckExternalConnectorCleanup = () => Interaction.where('#actor permits removal only for a confirmed exact owned connector', async actor => {
  const required = actor.hasAbilityTo(ExternalConnectors) && await actor.abilityTo(ExternalConnectors).needsCleanup();
  await notes().set('externalConnectorCleanupRequired', required).performAs(actor);
});

export const ReadRemovedConnector = () => Interaction.where('#actor confirms the UI removal call, applied tombstone and public absence', async actor => {
  const receipt = await actor.abilityTo(ExternalConnectors).confirmRemoved();
  await notes().set('externalConnectorRemoved', receipt).performAs(actor);
});

export const ReleaseExternalConnectorEndpoint = () => Interaction.where('#actor closes only the local TCP listener owned by this scenario', async actor => {
  if (actor.hasAbilityTo(ExternalConnectors)) await actor.abilityTo(ExternalConnectors).release();
});
