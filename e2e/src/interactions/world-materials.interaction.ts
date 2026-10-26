import { Interaction, notes } from '@serenity-js/core';
import { WorldMaterials } from '../abilities/world-materials.ability.js';

export const RememberWorldMaterialsSession = (kind: 'reimbursement' | 'order' = 'reimbursement') => Interaction.where('#actor remembers current public session operation IDs and the original active release', async actor => {
  await notes().set('worldMaterialsPreparation', await actor.abilityTo(WorldMaterials).prepare(kind)).performAs(actor);
});
export const SelectWorldMaterialsPolicies = () => Interaction.where('#actor selects only existing material scope, access and retention options', async actor => {
  await actor.abilityTo(WorldMaterials).selectPolicies();
});
export const UploadOriginalWorldMaterial = () => Interaction.where('#actor uploads hash-verified original bytes once with one local parse read, one model call and zero external Source reads', async actor => {
  await actor.abilityTo(WorldMaterials).upload();
});
export const ReadRetainedOrderMaterialUpload = () => Interaction.where('#actor reads only the exact upload ID from the original failed World import, without retrying any command', async actor => {
  await notes().set('worldOrderUploadReadback', await actor.abilityTo(WorldMaterials).readRetainedOrderUpload()).performAs(actor);
});
export const ReadWorldMaterialUpload = () => Interaction.where('#actor reads the exact original upload receipt, including unknown outcomes, without resubmission', async actor => {
  await notes().set('worldMaterialsUpload', await actor.abilityTo(WorldMaterials).readUpload()).performAs(actor);
});
export const SelectOwnWorldMaterialOperation = () => Interaction.where('#actor selects the sole newly admitted operation from the same upload attempt', async actor => {
  await actor.abilityTo(WorldMaterials).selectOperation();
});
export const ReadWorldMaterialOperation = () => Interaction.where('#actor reads the exact original final materials operation receipt, never resumes or retries it', async actor => {
  await notes().set('worldMaterialsOperation', await actor.abilityTo(WorldMaterials).readOperation()).performAs(actor);
});
export const ReadWorldMaterialParse = () => Interaction.where('#actor independently reads the exact original source and parse artifact with byte-position coverage', async actor => {
  await notes().set('worldMaterialsParsed', await actor.abilityTo(WorldMaterials).readParse()).performAs(actor);
});
export const ReadWorldMaterialDraft = () => Interaction.where('#actor independently reads persistent extraction candidates, model-call identities and original-source evidence after completed alignment', async actor => {
  await notes().set('worldMaterialsDraft', await actor.abilityTo(WorldMaterials).readDraft()).performAs(actor);
});
export const ReadExactOrderMaterialSource = () => Interaction.where('#actor reads the unique whole exact43B SourceVersion from the completed original import and complete public catalog', async actor => {
  await notes().set('worldOrderMaterialSource', await actor.abilityTo(WorldMaterials).readOrderSource()).performAs(actor);
});
export const ReadRefreshedWorldMaterial = () => Interaction.where('#actor rereads the identical source, parse artifact, complete draft and operation after UI refresh without any mutation', async actor => {
  await notes().set('worldMaterialsRefresh', await actor.abilityTo(WorldMaterials).readRefresh()).performAs(actor);
});
export const UploadZeroModelWorldMaterial = () => Interaction.where('#actor records exact new synthetic bytes and submits the only zero-model-budget UI upload attempt', async actor => {
  await actor.abilityTo(WorldMaterials).uploadZeroModelRejection();
});
export const ReadWorldMaterialRejection = (refreshed = false) => Interaction.where('#actor reads this upload’s complete public business rejection, sealed bytes and unchanged World without retrying', async actor => {
  await notes().set(refreshed ? 'worldMaterialsRejectionRefresh' : 'worldMaterialsRejection',
    await actor.abilityTo(WorldMaterials).readZeroModelRejection(refreshed)).performAs(actor);
});
