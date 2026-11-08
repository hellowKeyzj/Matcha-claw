import { Task } from '@serenity-js/core';
import { ExerciseIabBrowser } from '../interactions/iab-browser.interaction.js';
import { EnterChat } from './chat.task.js';

export const VerifyEmbeddedBrowser = () => Task.where('#actor verifies the embedded browser through its real UI, clearing site data last',
  EnterChat(),
  ExerciseIabBrowser(),
);
