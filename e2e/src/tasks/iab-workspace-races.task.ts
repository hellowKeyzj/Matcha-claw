import { Task } from '@serenity-js/core';
import { ExerciseIabWorkspaceRace } from '../interactions/iab-workspace-races.interaction.js';
import { EnterChat } from './chat.task.js';

export const VerifyIabWorkspaceRace = (caseId: 10 | 11 | 12, iteration: number) => Task.where(
  `#actor exercises IAB race ${caseId}, iteration ${iteration}, without fabricated IPC results`,
  EnterChat(),
  ExerciseIabWorkspaceRace(caseId, iteration),
);
