import { Task } from '@serenity-js/core';
import {
  CleanUpPublicAttachmentSession, CreateSessionThroughPublicCapability, ReplayPublicFixedPng, SendPublicFixedPng,
  SendPublicTextBaseline, StageFixedPngThroughDialog, WaitForPublicSessionCatalog,
} from '../interactions/session-capabilities.interaction.js';

export const CreatePublicSession = () => Task.where('#actor creates an independent OpenClaw session through the public capability',
  WaitForPublicSessionCatalog(),
  CreateSessionThroughPublicCapability(),
);

export const PreparePublicFixedPng = () => Task.where('#actor places the fixed PNG into Main-owned attachment custody',
  StageFixedPngThroughDialog(),
);

export const SendPublicSessionBaseline = () => Task.where('#actor waits for a persisted completed text baseline before sending media',
  SendPublicTextBaseline(),
);

export const DeliverPublicFixedPng = () => Task.where('#actor delivers the staged fixed PNG',
  SendPublicFixedPng(),
);

export const RestorePublicAttachmentSession = () => Task.where('#actor restores only its owned public-contract resources', CleanUpPublicAttachmentSession());

export const AttemptPublicAttachmentReplay = () => Task.where('#actor attempts to replay the consumed attachment',
  ReplayPublicFixedPng(),
);
