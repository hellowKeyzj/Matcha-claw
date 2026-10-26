import { equals } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait, notes } from '@serenity-js/core';
import { Attribute, Click, isEnabled, isVisible } from '@serenity-js/web';
import { ReadProviderRoutingUiExpectation, RequestProviderRouting } from '../interactions/provider-routing.interaction.js';
import { ProviderRoutingPage } from '../pages/provider-routing.page.js';
import {
  ProviderRoutingPanelIsOpen, ProviderRoutingPanelStateWasSaved, ProviderRoutingPanelWasOpen, ProviderRoutingPrimaryMatchesPublicFacts,
} from '../questions/provider-routing.question.js';
import { EnterChat } from './chat.task.js';

export const ReadPublicProviderRouting = () => Task.where('#actor reads the public provider routing projection through the API boundary',
  RequestProviderRouting('list'),
);

export const CompareProviderRoutingUi = () => Task.where('#actor inspects the current Models allocation panel without changing routing',
  EnterChat(),
  Click.on(ProviderRoutingPage.navigation),
  Wait.until(ProviderRoutingPage.toggle, isVisible()),
  notes().set('providerRoutingPanelWasOpen', ProviderRoutingPanelIsOpen()),
  Check.whether(ProviderRoutingPanelWasOpen(), equals(false)).andIfSo(Click.on(ProviderRoutingPage.toggle)),
  Wait.upTo(Duration.ofSeconds(45)).until(ProviderRoutingPage.refresh, isEnabled()),
  Wait.until(ProviderRoutingPage.primary('chat'), isVisible()),
  ReadProviderRoutingUiExpectation(),
  Wait.until(ProviderRoutingPrimaryMatchesPublicFacts(), equals(true)),
);

export const RestoreProviderRoutingPanel = () => Task.where('#actor restores only the routing panel disclosure state',
  Check.whether(ProviderRoutingPanelStateWasSaved(), equals(true)).andIfSo(
    Check.whether(ProviderRoutingPanelWasOpen(), equals(false)).andIfSo(
      Check.whether(Attribute.called('aria-expanded').of(ProviderRoutingPage.toggle), equals('true')).andIfSo(Click.on(ProviderRoutingPage.toggle)),
    ),
  ),
);

export const RequestInvalidProviderRouting = () => Task.where('#actor requests provider routing with a private extra field through the API boundary',
  RequestProviderRouting('invalid'),
);

export const RequestUnknownProviderRoutingCapability = () => Task.where('#actor requests an unknown capability with private input through the API boundary',
  RequestProviderRouting('unknown'),
);
