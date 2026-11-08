import { notes } from '@serenity-js/core';

export const EmbeddedBrowserSummary = () => notes<{ iabSummary: { passed: number; failed: number } }>().get('iabSummary');
