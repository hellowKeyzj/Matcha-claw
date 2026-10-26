import { Question, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { TeamLifecyclePage } from '../pages/team-lifecycle.page.js';

type TeamLifecycleNotes = {
  teamLifecycleReview: { selectionSealed: boolean; packageValid: boolean; dependenciesReady: boolean };
  teamLifecycleResource: { name: string; packageRoot: string };
  teamLifecycleOwnership: { teamId: string; runId: string; nodeIds: string[] };
  teamLifecycleCleanup: { purgeRun: boolean; deleteTeam: boolean };
  teamLifecycleResult: {
    creationPath: string; materializationAccepted: boolean; materializationCommitted: boolean; runCreated: boolean;
    runtimeConfirmed: boolean; roleSessionsBound: boolean; graphProjected: boolean; startGate: string;
    modelExecution: string; businessCompletion: string; cancellation: string;
    runPurged: boolean; teamTombstoned: boolean; otherTeamsUnchanged: boolean;
  };
};

export const TrustedTeamSkillReview = () => notes<TeamLifecycleNotes>().get('teamLifecycleReview');
export const OwnedTeamLifecycleResult = () => notes<TeamLifecycleNotes>().get('teamLifecycleResult');
export const OwnedTeamResource = () => notes<TeamLifecycleNotes>().get('teamLifecycleResource');
export const OwnedTeamNeedsRunPurge = () => notes<TeamLifecycleNotes>().get('teamLifecycleCleanup').purgeRun;
export const OwnedTeamNeedsDeletion = () => notes<TeamLifecycleNotes>().get('teamLifecycleCleanup').deleteTeam;
export const TeamLifecycleWasReserved = () => notes<TeamLifecycleNotes>().has('teamLifecycleResource');
export const TeamNames = () => Text.ofAll(TeamLifecyclePage.teamNames);
export const TeamListIsReady = () => Question.about('the Team directory shows its actual collection or empty state', async actor =>
  await actor.answer(TeamLifecyclePage.teamList.isVisible())
  && (await actor.answer(TeamLifecyclePage.teamNames.count()) > 0 || await actor.answer(TeamLifecyclePage.emptyTeamList.isVisible())),
);
export const TeamCanvasIsReady = () => Question.about('the exact owned graph is visible, nonempty and laid out', async actor => {
  const owned = await actor.answer(notes<TeamLifecycleNotes>().get('teamLifecycleOwnership'));
  if (!await actor.answer(TeamLifecyclePage.canvas.isVisible())
    || !await actor.answer(TeamLifecyclePage.graph.isVisible())
    || await actor.answer(Attribute.called('inert').of(TeamLifecyclePage.canvas).isPresent())
    || !await actor.answer(TeamLifecyclePage.detailHeading(OwnedTeamResource().name).isVisible())
    || await actor.answer(Attribute.called('title').of(TeamLifecyclePage.runHistory)) !== owned.runId
    || !await actor.answer(TeamLifecyclePage.nodes.first().isVisible())) return false;
  const nodeIds = await actor.answer(TeamLifecyclePage.nodes.eachMappedTo(Attribute.called('data-node-id')));
  return nodeIds.length > 0 && JSON.stringify([...nodeIds].sort()) === JSON.stringify(owned.nodeIds);
});
