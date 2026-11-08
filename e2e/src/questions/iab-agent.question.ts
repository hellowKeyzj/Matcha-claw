import { notes } from '@serenity-js/core';

export const AgentBrowserWasVerified = () => notes<{ iabAgentVerified: boolean }>().get('iabAgentVerified');
