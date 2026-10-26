import { Ensure, matches, not } from '@serenity-js/assertions';
import { Duration, Interaction, Wait, notes } from '@serenity-js/core';
import { Click, Text, isEnabled, isVisible } from '@serenity-js/web';
import { ChannelControl } from '../abilities/channel-control.ability.js';
import { ChannelControlPage } from '../pages/channel-control.page.js';

const privateMaterial = /configPath|openclaw\.json|sourcePath|sourceDir|workspaceDir|qrDataUrl|authorizationUrl|(?:token|secret|credential)\s*[:=]|data:image\//i;

export const ExerciseConfiguredChannelSandbox = () => Interaction.where('#actor connects only the configured sandbox and restores its confirmed disconnected baseline', async actor => {
  const control = actor.abilityTo(ChannelControl);
  await control.requirePreparedSandbox();
  await Ensure.that(ChannelControlPage.currentOpenClaw, isVisible()).performAs(actor);
  await Wait.upTo(Duration.ofSeconds(10)).until(ChannelControlPage.sandboxCard, isVisible()).performAs(actor);
  await Ensure.that(ChannelControlPage.disconnected, isVisible()).performAs(actor);
  await Ensure.that(Text.of(ChannelControlPage.body), not(matches(privateMaterial))).performAs(actor);
  await Ensure.that(Text.of(ChannelControlPage.sandboxCard), not(matches(/e2e-sandbox-account/))).performAs(actor);
  try {
    await control.connect();
    await Wait.upTo(Duration.ofSeconds(10)).until(ChannelControlPage.refresh, isEnabled()).performAs(actor);
    await Click.on(ChannelControlPage.refresh).performAs(actor);
    await Wait.upTo(Duration.ofSeconds(30)).until(ChannelControlPage.connected, isVisible()).performAs(actor);
    await Ensure.that(Text.of(ChannelControlPage.sandboxCard), not(matches(privateMaterial))).performAs(actor);
    await Ensure.that(Text.of(ChannelControlPage.sandboxCard), not(matches(/e2e-sandbox-account/))).performAs(actor);
    await notes<{ channelControlConnected: boolean }>().set('channelControlConnected', true).performAs(actor);
  } finally {
    const settlement = await control.restoreDisconnectedBaseline();
    if (settlement) {
      await Wait.upTo(Duration.ofSeconds(10)).until(ChannelControlPage.refresh, isEnabled()).performAs(actor);
      await Click.on(ChannelControlPage.refresh).performAs(actor);
      await Wait.upTo(Duration.ofSeconds(30)).until(ChannelControlPage.disconnected, isVisible()).performAs(actor);
      await Ensure.that(Text.of(ChannelControlPage.sandboxCard), not(matches(privateMaterial))).performAs(actor);
      await Ensure.that(Text.of(ChannelControlPage.sandboxCard), not(matches(/e2e-sandbox-account/))).performAs(actor);
      await notes<{ channelControlSettlement: typeof settlement }>().set('channelControlSettlement', settlement).performAs(actor);
      await notes<{ channelControlBaselineRestored: boolean }>().set('channelControlBaselineRestored', true).performAs(actor);
    }
  }
});
