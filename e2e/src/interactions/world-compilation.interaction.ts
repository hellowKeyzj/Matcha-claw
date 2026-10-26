import { Interaction, notes } from '@serenity-js/core';
import { WorldCompilation } from '../abilities/world-compilation.ability.js';
import { WorldWorkspace } from '../abilities/world-workspace.ability.js';
import { Selected, Text } from '@serenity-js/web';
import { WorldAuthoringPage } from '../pages/world-authoring.page.js';
import { WorldCompilationPage } from '../pages/world-compilation.page.js';

export const ReadWorldOrderOriginals = () => Interaction.where('#actor reads the three unchanged non-secret order-authoring originals', async actor => {
  await notes().set('worldOrderOriginal', await actor.abilityTo(WorldCompilation).readOriginalInputs()).performAs(actor);
});
export const ImportWorldOrderTaskFile = () => Interaction.where('#actor loads the original order Task through its normal file control without registering it', async actor => {
  await actor.abilityTo(WorldCompilation).importTaskPreview();
});
export const ImportWorldOrderDefinitionFile = () => Interaction.where('#actor loads the original Function and Strategy file without sending a World command', async actor => {
  await actor.abilityTo(WorldCompilation).importDefinitionsPreview();
});
export const ReadWorldOrderTask = () => Interaction.where('#actor reads the exact original order Task; only an explicit null permits registration', async actor => {
  await notes().set('worldOrderTask', await actor.abilityTo(WorldCompilation).inspectTask()).performAs(actor);
});
export const MarkWorldOrderRegistration = () => Interaction.where('#actor fences a single normal UI registration without changing the original Oracle pin', async actor => {
  await actor.abilityTo(WorldCompilation).markRegistration();
});
export const ConfirmWorldOrderRegistration = () => Interaction.where('#actor verifies the original completed registration receipt through the existing workspace reader', async actor => {
  const id = await actor.answer(Selected.valueOf(WorldCompilationPage.operationSession));
  const receipt = await actor.abilityTo(WorldWorkspace).inspectOperation(id);
  if (receipt.phase !== 'completed') throw new Error(`Original order registration operation=${id}; phase=${receipt.phase}; no retry attempted`);
  await notes().set('worldOrderRegistration', await actor.abilityTo(WorldCompilation).confirmOperation(id, 'task')).performAs(actor);
});
export const ReadWorldOrderProposalPrerequisites = () => Interaction.where('#actor checks the public zero-Source structural proposal prerequisites, without requiring Schema or Execute', async actor => {
  const lock = await actor.answer(Selected.valueOf(WorldAuthoringPage.targetLock));
  await notes().set('worldOrderProposalPrerequisites', await actor.abilityTo(WorldCompilation).inspectProposalPrerequisites(lock)).performAs(actor);
});
export const MarkWorldOrderProposal = () => Interaction.where('#actor fences one normal UI proposal and observes its public operation hints without intercepting requests', async actor => {
  await actor.abilityTo(WorldCompilation).markProposal(await actor.answer(Selected.valueOf(WorldAuthoringPage.targetLock)));
});
export const ConfirmWorldOrderProposal = () => Interaction.where('#actor reads the actual UI proposal operation receipt and independently verifies its complete Candidate, ChangeSet, public branch and immutable definitions', async actor => {
  await notes().set('worldOrderProposal', await actor.abilityTo(WorldCompilation).confirmCommand('proposed')).performAs(actor);
});
export const MarkWorldOrderValidation = () => Interaction.where('#actor rereads and fences only the exact selected proposed change revision before one validation click', async actor => {
  await actor.abilityTo(WorldCompilation).markValidation(await actor.answer(Text.of(WorldCompilationPage.changeId)));
});
export const ConfirmWorldOrderValidation = () => Interaction.where('#actor verifies the validation Candidate receipt and the same durable branch without executing or publishing', async actor => {
  await notes().set('worldOrderValidation', await actor.abilityTo(WorldCompilation).confirmCommand('validated')).performAs(actor);
});
export const PrepareWorldOrderStructure = () => Interaction.where('#actor selects fresh submission or explicit public-record resume, never inferring an old operation', async actor => {
  await notes().set('worldOrderStructure', await actor.abilityTo(WorldCompilation).prepareStructure()).performAs(actor);
});
export const ReadWorldOrderStructure = () => Interaction.where('#actor replays only the recorded persisted structural result, not its unavailable original Candidate or Operation receipts', async actor => {
  await notes().set('worldOrderResume', await actor.abilityTo(WorldCompilation).resumeStructure()).performAs(actor);
});
export const ReleaseWorldOrderObservation = () => Interaction.where('#actor releases only the owned read-only World event subscription, preserving any unknown mutation identity', async actor => {
  await actor.abilityTo(WorldCompilation).releaseObservation();
});
