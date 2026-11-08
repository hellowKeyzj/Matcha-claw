import { Check, Task } from '@serenity-js/core';
import { isVisible } from '@serenity-js/web';
import { ExerciseIabWorkspace } from '../interactions/iab-workspace.interaction.js';
import { ChatPage } from '../pages/chat.page.js';
import { EnterChat } from './chat.task.js';

export const VerifyIabWorkspace = (caseId: number) => Task.where(
  `#actor verifies IAB workspace case ${caseId} in the existing Chat`,
  Check.whether(ChatPage.workspaceHost, isVisible()).andIfSo().otherwise(EnterChat()),
  ExerciseIabWorkspace(caseId),
);
