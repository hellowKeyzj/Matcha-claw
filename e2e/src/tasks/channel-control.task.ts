import { Duration, Task, Wait } from '@serenity-js/core';
import { Click, isVisible } from '@serenity-js/web';
import { ExerciseConfiguredChannelSandbox } from '../interactions/channel-control.interaction.js';
import { ChannelControlPage } from '../pages/channel-control.page.js';
import { EnterChat } from './chat.task.js';

export const VerifyConfiguredSandboxControl = () => Task.where('#actor verifies public sandbox control and its real Channels presentation',
  EnterChat(),
  Click.on(ChannelControlPage.navigation),
  Wait.upTo(Duration.ofSeconds(30)).until(ChannelControlPage.heading, isVisible()),
  ExerciseConfiguredChannelSandbox(),
);
