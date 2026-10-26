import { Interaction, notes } from '@serenity-js/core';
import { WorldWorkspace } from '../abilities/world-workspace.ability.js';

export const ReadWorkspaceCatalogs = (round: number) => Interaction.where(`#actor concurrently reads all six authorized directories to terminal cursors, round ${round} of 5`, async actor => {
  await notes().set('workspaceCatalogs', await actor.abilityTo(WorldWorkspace).readCatalogRound(round)).performAs(actor);
});
export const RememberWorkspaceOriginals = () => Interaction.where('#actor reads the exact original Task, NoOp and active release without a command', async actor => {
  await notes().set('workspaceOriginal', await actor.abilityTo(WorldWorkspace).rememberOriginal()).performAs(actor);
});
export const ConfirmWorkspaceOriginals = () => Interaction.where('#actor confirms the complete original Task, NoOp and active release remained unchanged in this case', async actor => {
  await notes().set('workspaceUnchanged', await actor.abilityTo(WorldWorkspace).confirmOriginal()).performAs(actor);
});
export const ReadWorkspaceObjectsDecodeFailures = () => Interaction.where('#actor requires eight exact public objects Decode failures without issuing a command or invoking a dataset', async actor => {
  await notes().set('workspaceObjectsDecodeFailures', await actor.abilityTo(WorldWorkspace).inspectObjectsDecodeFailures()).performAs(actor);
});
export const ReadWorkspaceTask = () => Interaction.where('#actor reads the complete authorized Task scope and the actual TaskResolution prerequisites', async actor => {
  await notes().set('workspaceTask', await actor.abilityTo(WorldWorkspace).prepareTaskReading()).performAs(actor);
});
export const ReachOriginalWorkspaceTask = (surface: 'management' | 'authoring') => Interaction.where(`#actor follows normal ${surface} Task pagination to the original exact revision`, async actor => {
  await actor.abilityTo(WorldWorkspace).reachOriginalTask(surface);
});
export const ReadRenderedWorkspaceTask = () => Interaction.where('#actor compares every rendered full Task field with its exact original public contract', async actor => {
  await notes().set('workspaceTaskRendered', await actor.abilityTo(WorldWorkspace).confirmTaskRendering()).performAs(actor);
});
export const ReadWorkspaceSession = () => Interaction.where('#actor reads only real session-tracked OperationKeys and creates an unrelated missing lookup key', async actor => {
  await notes().set('workspaceSession', await actor.abilityTo(WorldWorkspace).prepareOperations()).performAs(actor);
});
export const ReadWorkspaceOperation = () => Interaction.where('#actor reads public status and result for the actual selected session OperationKey', async actor => {
  const session = await actor.answer(notes<{ workspaceSession: { first: string } }>().get('workspaceSession'));
  await notes().set('workspaceOperation', await actor.abilityTo(WorldWorkspace).inspectOperation(session.first)).performAs(actor);
});
export const ReadMissingWorkspaceOperation = () => Interaction.where('#actor requires typed not-found from public status and result for the unrelated OperationKey', async actor => {
  const session = await actor.answer(notes<{ workspaceSession: { missing: string } }>().get('workspaceSession'));
  await notes().set('workspaceMissing', await actor.abilityTo(WorldWorkspace).inspectMissingOperation(session.missing)).performAs(actor);
});
