import { Question, notes } from '@serenity-js/core';
import { Attribute, Selected } from '@serenity-js/web';
import { ProviderRoutingPage } from '../pages/provider-routing.page.js';

type ProviderRoutingNotes = {
  providerRoutingPanelWasOpen: boolean;
  providerRoutingPrimary: Record<string, string>;
  providerRoutingReply: {
    ipcSucceeded: boolean;
    matchesStatus: boolean;
    matchesPublicBody: boolean;
    publicProjectionSafe: boolean;
  };
};

export const ProviderRoutingReply = () => notes<ProviderRoutingNotes>().get('providerRoutingReply');
export const ProviderRoutingPanelIsOpen = () => Question.about('the routing allocation panel is expanded', async actor =>
  await actor.answer(Attribute.called('aria-expanded').of(ProviderRoutingPage.toggle)) === 'true',
);
export const ProviderRoutingPanelStateWasSaved = () => notes<ProviderRoutingNotes>().has('providerRoutingPanelWasOpen');
export const ProviderRoutingPanelWasOpen = () => notes<ProviderRoutingNotes>().get('providerRoutingPanelWasOpen');
export const ProviderRoutingPrimaryMatchesPublicFacts = () => Question.about('the six displayed primary model identities match the public routing and catalog', async actor => {
  const primary = await actor.answer(notes<ProviderRoutingNotes>().get('providerRoutingPrimary'));
  for (const [capability, expected] of Object.entries(primary)) {
    if (await actor.answer(Selected.valueOf(ProviderRoutingPage.primary(capability))) !== expected) return false;
  }
  return Object.keys(primary).length === 6;
});
