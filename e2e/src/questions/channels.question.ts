import { Question, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { ChannelsPage } from '../pages/channels.page.js';

type Receipt = { transportOk: boolean; status: number | null; httpOk: boolean; contractValid: boolean };
type ChannelsNotes = {
  channelsPublicState: { status: Receipt; snapshot: Receipt & { ready: boolean }; configuredCount: number; redacted: boolean };
  channelsRejections: {
    invalidStatus: Receipt & { redacted: boolean };
    invalidSnapshot: Receipt & { redacted: boolean };
    invalidControl: Receipt & { redacted: boolean };
  };
};

export const ChannelsRuntime = () => Question.about('the runtime selected by the Channels UI', async actor => {
  if (await actor.answer(ChannelsPage.openClawSelected.isVisible())) return 'openclaw' as const;
  if (await actor.answer(ChannelsPage.matchaSelected.isVisible())) return 'matcha-agent' as const;
  throw new Error('Channels requires a selected local OpenClaw or Matcha Agent runtime');
});

export const ChannelsIsVisible = () => Question.about('the naturally selected Channels page and its loaded public summary are visible', async actor =>
  await actor.answer(ChannelsPage.heading.isVisible())
  && await actor.answer(Attribute.called('aria-current').of(ChannelsPage.navigation)) === 'page'
  && await actor.answer(ChannelsPage.loadErrors.count()) === 0
  && await actor.answer(ChannelsPage.total.isVisible())
  && await actor.answer(ChannelsPage.available.isVisible()),
);

export const ChannelsBodyIsRedacted = () => Text.of(ChannelsPage.body)
  .as(text => !/configPath|openclaw\.json|native connection details|e2e-channels-public-canary-v1/i.test(text));
export const ChannelsDisplayedCount = () => Text.of(ChannelsPage.total).as(text => Number(text.trim()));
export const ChannelsConfiguredCount = () => notes<ChannelsNotes>().get('channelsPublicState').configuredCount;
export const ChannelsStatusReceipt = () => notes<ChannelsNotes>().get('channelsPublicState').status;
export const ChannelsSnapshotReceipt = () => notes<ChannelsNotes>().get('channelsPublicState').snapshot;
export const ChannelsPublicStateIsRedacted = () => notes<ChannelsNotes>().get('channelsPublicState').redacted;
export const ChannelsInvalidStatusReceipt = () => notes<ChannelsNotes>().get('channelsRejections').invalidStatus;
export const ChannelsInvalidSnapshotReceipt = () => notes<ChannelsNotes>().get('channelsRejections').invalidSnapshot;
export const ChannelsInvalidControlReceipt = () => notes<ChannelsNotes>().get('channelsRejections').invalidControl;
