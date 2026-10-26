import { Duration, Task, Wait, notes } from '@serenity-js/core';
import { Ensure, equals } from '@serenity-js/assertions';
import { Click } from '@serenity-js/web';
import { ObserveChannelsPublicState, ObserveChannelsRejections } from '../interactions/channels.interaction.js';
import { ChannelsPage } from '../pages/channels.page.js';
import { ChannelsConfiguredCount, ChannelsDisplayedCount, ChannelsIsVisible, ChannelsRuntime } from '../questions/channels.question.js';
import { EnterChat } from './chat.task.js';

export const EnterChannels = () => Task.where('#actor reaches Channels through the ordinary sidebar without changing its runtime or accounts',
  EnterChat(),
  Click.on(ChannelsPage.navigation),
  Wait.upTo(Duration.ofSeconds(45)).until(ChannelsIsVisible(), equals(true)),
  notes<{ channelsRuntime: 'openclaw' | 'matcha-agent' }>().set('channelsRuntime', ChannelsRuntime()),
);

export const ReadChannelsPublicState = () => Task.where('#actor observes the real public Channels DTOs',
  ObserveChannelsPublicState(),
);

export const MatchChannelsSummary = () => Task.where('#actor waits for the UI count to match the ready public snapshot',
  Wait.upTo(Duration.ofSeconds(45)).until(ChannelsDisplayedCount(), equals(ChannelsConfiguredCount())),
  Ensure.that(ChannelsIsVisible(), equals(true)),
);

export const ReadChannelsRejections = () => Task.where('#actor observes strict invalid-status, unavailable-scope and invalid-control errors separately',
  ObserveChannelsRejections(),
);

export const LeaveChannels = () => Task.where('#actor returns to local Chat without changing channel configuration',
  EnterChat(),
);
