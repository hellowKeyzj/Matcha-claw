import { Interaction, notes } from '@serenity-js/core';
import { UseSessionCapabilities } from '../abilities/use-session-capabilities.ability.js';

export const WaitForPublicSessionCatalog = () => Interaction.where('#actor waits for the real public OpenClaw session catalog', async actor => {
  const ready = await actor.abilityTo(UseSessionCapabilities).waitForSessionCatalog();
  await notes<{ publicSessionCatalogReady: boolean }>().set('publicSessionCatalogReady', ready).performAs(actor);
});

export const CreateSessionThroughPublicCapability = () => Interaction.where('#actor creates a unique session through its public agent capability', async actor => {
  const receipt = await actor.abilityTo(UseSessionCapabilities).createSession();
  await notes<{ publicSessionCreation: typeof receipt }>().set('publicSessionCreation', receipt).performAs(actor);
});

export const StageFixedPngThroughDialog = () => Interaction.where('#actor stages the fixed PNG through the retained dialog IPC', async actor => {
  const staged = await actor.abilityTo(UseSessionCapabilities).stageFixedPng();
  await notes<{ fixedPngStaged: boolean }>().set('fixedPngStaged', staged).performAs(actor);
});

export const SendPublicTextBaseline = () => Interaction.where('#actor sends a text-only baseline to this session', async actor => {
  const receipt = await actor.abilityTo(UseSessionCapabilities).sendTextBaseline();
  await notes<{ publicTextReceipt: typeof receipt }>().set('publicTextReceipt', receipt).performAs(actor);
});

export const SendPublicFixedPng = () => Interaction.where('#actor sends the staged PNG through the public session capability', async actor => {
  const receipt = await actor.abilityTo(UseSessionCapabilities).sendFixedPng();
  await notes<{ publicPngReceipt: typeof receipt }>().set('publicPngReceipt', receipt).performAs(actor);
});

export const CleanUpPublicAttachmentSession = () => Interaction.where('#actor releases its own staged attachment and deletes only its settled session', actor =>
  actor.abilityTo(UseSessionCapabilities).cleanup());

export const ReplayPublicFixedPng = () => Interaction.where('#actor reuses the same staged PNG ID with a new run ID', async actor => {
  const receipt = await actor.abilityTo(UseSessionCapabilities).replayFixedPng();
  await notes<{ publicPngReplay: typeof receipt }>().set('publicPngReplay', receipt).performAs(actor);
});
