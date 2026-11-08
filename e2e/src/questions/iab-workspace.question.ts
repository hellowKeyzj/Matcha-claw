import { notes } from '@serenity-js/core';

export const IabWorkspaceVerified = () => notes<{ iabWorkspaceVerified: number }>().get('iabWorkspaceVerified');
