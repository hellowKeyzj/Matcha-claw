import { Question, notes } from '@serenity-js/core';
import { Text } from '@serenity-js/web';
import { TeamBoundariesPage } from '../pages/team-boundaries.page.js';

type TeamBoundaryReceipt = {
  ipcOk: boolean;
  status: number | null;
  httpOk: boolean;
  exactBody: boolean;
  privatePathExposed: boolean;
  privateContentExposed: boolean;
};
type TeamBoundaryNotes = {
  invalidTeamSkillReceipt: TeamBoundaryReceipt;
  electronTeamBoundaryReceipt: TeamBoundaryReceipt;
  rustTeamBoundaryReceipt: TeamBoundaryReceipt;
  originalTeamsUnchanged: boolean;
};

export const TeamBoundaryListIsReady = () => Question.about('the Team directory shows its actual collection or empty state', async actor =>
  await actor.answer(TeamBoundariesPage.teamList.isVisible())
  && (await actor.answer(TeamBoundariesPage.teamNames.count()) > 0 || await actor.answer(TeamBoundariesPage.emptyTeamList.isVisible())),
);
export const InvalidTeamSkillAlert = () => Text.of(TeamBoundariesPage.alert);
export const InvalidTeamSkillCreateIsEnabled = () => TeamBoundariesPage.create.isEnabled();
export const OriginalTeamsAreUnchanged = () => notes<TeamBoundaryNotes>().get('originalTeamsUnchanged');
export const InvalidTeamSkillReceipt = () => notes<TeamBoundaryNotes>().get('invalidTeamSkillReceipt');
export const ElectronTeamBoundaryReceipt = () => notes<TeamBoundaryNotes>().get('electronTeamBoundaryReceipt');
export const RustTeamBoundaryReceipt = () => notes<TeamBoundaryNotes>().get('rustTeamBoundaryReceipt');
