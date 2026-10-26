import { Duration, Task, Wait } from '@serenity-js/core';
import { equals } from '@serenity-js/assertions';
import { Click, isEnabled, isVisible } from '@serenity-js/web';
import {
  CompareOriginalTeams, CompleteInvalidTeamSkillPicker, DismissTeamBoundaryDialog, OpenTeamBoundaryDialog,
  PrepareInvalidTeamSkill, RememberOriginalTeams, RemoveInvalidTeamSkill,
  SubmitAdditionalTeamSkillInput, SubmitMismatchedTeamSkillTarget, ValidateInvalidTeamSkill,
} from '../interactions/team-boundaries.interaction.js';
import { TeamBoundariesPage } from '../pages/team-boundaries.page.js';
import { TeamBoundaryListIsReady } from '../questions/team-boundaries.question.js';

export const CheckInvalidTeamSkillPackage = () => Task.where('#actor checks the exact public invalid receipt for its own temporary TeamSkill',
  PrepareInvalidTeamSkill(),
  ValidateInvalidTeamSkill(),
);

export const ReviewInvalidTeamSkillThroughUI = () => Task.where('#actor submits its invalid TeamSkill through the real Team creation UI and native picker',
  Click.on(TeamBoundariesPage.navigation),
  Wait.until(TeamBoundariesPage.title, isVisible()),
  Wait.until(TeamBoundaryListIsReady(), equals(true)),
  RememberOriginalTeams(),
  OpenTeamBoundaryDialog(),
  Wait.until(TeamBoundariesPage.createDialog, isVisible()),
  Click.on(TeamBoundariesPage.teamSkillTab),
  Wait.upTo(Duration.ofSeconds(45)).until(TeamBoundariesPage.choosePackage, isEnabled()),
  Click.on(TeamBoundariesPage.choosePackage),
  Click.on(TeamBoundariesPage.chooseDirectory),
  CompleteInvalidTeamSkillPicker(),
  Wait.upTo(Duration.ofSeconds(45)).until(TeamBoundariesPage.alert, isVisible()),
);

export const CancelInvalidTeamSkillReview = () => Task.where('#actor cancels the rejected Team creation and compares the original collection',
  Click.on(TeamBoundariesPage.cancel),
  Wait.until(TeamBoundariesPage.createDialog.isVisible(), equals(false)),
  Wait.until(TeamBoundaryListIsReady(), equals(true)),
  CompareOriginalTeams(),
);

export const RestoreTeamBoundaryDialog = () => Task.where('#actor restores its own Team creation dialog', DismissTeamBoundaryDialog());
export const CleanupInvalidTeamSkillPackage = () => Task.where('#actor removes its own temporary TeamSkill even when UI restoration fails', RemoveInvalidTeamSkill());

export const CheckElectronTeamBoundary = () => Task.where('#actor checks the public Electron TeamSkill request boundary',
  SubmitMismatchedTeamSkillTarget(),
);

export const CheckRustTeamBoundary = () => Task.where('#actor checks the public Rust TeamSkill request boundary',
  SubmitAdditionalTeamSkillInput(),
);
