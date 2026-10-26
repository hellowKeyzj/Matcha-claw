import { Interaction, notes } from '@serenity-js/core';
import { Channels } from '../abilities/channels.ability.js';

export const ObserveChannelsPublicState = () => Interaction.where('#actor reads the selected runtime through the public Channels status and snapshot routes', async actor => {
  const runtime = await actor.answer(notes<{ channelsRuntime: 'openclaw' | 'matcha-agent' }>().get('channelsRuntime'));
  const result = await actor.abilityTo(Channels).readPublicState(runtime);
  await notes<{ channelsPublicState: typeof result }>().set('channelsPublicState', result).performAs(actor);
});

export const ObserveChannelsRejections = () => Interaction.where('#actor submits invalid read-only Channels requests containing a synthetic canary', async actor => {
  const result = await actor.abilityTo(Channels).readRejections();
  await notes<{ channelsRejections: typeof result }>().set('channelsRejections', result).performAs(actor);
});
