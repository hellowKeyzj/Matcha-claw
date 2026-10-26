import { Task } from '@serenity-js/core';
import { Click, Navigate } from '@serenity-js/web';
import {
  AddWorldTrustDraft, CaptureWorldTrustPolicy, ReadWorldTrustAfterCancel, ReadWorldTrustAfterRefresh,
  RejectDuplicateWorldTrustKey, RejectInvalidWorldTrustKeys, RemoveWorldTrustDraft, ReviewAndCancelWorldTrust,
} from '../interactions/world-package-trust.interaction.js';
import { WorldWorkspacePage } from '../pages/world-workspace.page.js';
import { OpenExistingWorldWorkspace } from './world-workspace.task.js';

export const OpenWorldTrustDraft = () => Task.where('#actor opens the existing World settings and captures the complete unchanged trust policy',
  OpenExistingWorldWorkspace(), Click.on(WorldWorkspacePage.settingsNavigation), CaptureWorldTrustPolicy(),
);
export const InspectWorldTrustDraft = () => Task.where('#actor checks invalid input, one legal public draft and duplicate rejection without a trust replacement',
  RejectInvalidWorldTrustKeys(), AddWorldTrustDraft(), RejectDuplicateWorldTrustKey(),
);
export const RemoveOwnWorldTrustDraft = () => Task.where('#actor removes only its newly drafted public key, returning to no difference',
  RemoveWorldTrustDraft(),
);
export const CancelWorldTrustReplacement = () => Task.where('#actor previews the full replacement, reads the risk notice and cancels; no root addition is approved',
  AddWorldTrustDraft(), ReviewAndCancelWorldTrust(), ReadWorldTrustAfterCancel(),
);
export const RefreshWorldTrustDraft = () => Task.where('#actor normally reloads and re-enters the existing World to prove draft-only changes disappeared',
  Navigate.reloadPage(), OpenExistingWorldWorkspace(), Click.on(WorldWorkspacePage.settingsNavigation), ReadWorldTrustAfterRefresh(),
);
