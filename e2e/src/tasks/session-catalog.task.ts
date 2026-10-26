import { Task } from '@serenity-js/core';
import { CompareDraftCatalog, ExerciseIndependentCatalogSession, RememberPublicCatalog } from '../interactions/session-catalog.interaction.js';
import { WaitForPublicSessionCatalog } from '../interactions/session-capabilities.interaction.js';
import { StartOpenClawDraft } from './chat.task.js';

export const RecordReadySessionCatalog = () => Task.where('#actor records the ready public OpenClaw catalog',
  WaitForPublicSessionCatalog(),
  RememberPublicCatalog(),
);

export const SelectCatalogDraft = () => Task.where('#actor selects the OpenClaw main Agent draft without creating a native session',
  StartOpenClawDraft(),
  CompareDraftCatalog(),
);

export const VerifyIndependentCatalogSession = () => Task.where('#actor verifies an independent catalog entry and delivered bounded facts with accurate gaps',
  ExerciseIndependentCatalogSession(),
);
