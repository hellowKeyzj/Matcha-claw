import { Task } from '@serenity-js/core';
import { RequestMalformedSessionCatalog } from '../interactions/session-boundaries.interaction.js';
import { EnterChat } from './chat.task.js';

export const SubmitMalformedSessionCatalog = () => Task.where('#actor checks malformed session catalog input from the usable Chat',
  EnterChat(),
  RequestMalformedSessionCatalog(),
);
