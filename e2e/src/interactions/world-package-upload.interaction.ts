import { Interaction, notes } from '@serenity-js/core';
import { WorldPackageSetup } from '../abilities/world-package-setup.ability.js';

export const CaptureWorldPackageUpload = () => Interaction.where('#actor reads the original inventory and release before selecting a new four-byte ZIP', async actor => {
  await notes().set('worldPackageUpload', await actor.abilityTo(WorldPackageSetup).preparePackageUpload()).performAs(actor);
});
export const LoadWorldPackageUploadReadback = () => Interaction.where('#actor loads only the retained repaired-build upload identity and baseline without submitting anything', async actor => {
  await notes().set('worldPackageUpload', await actor.abilityTo(WorldPackageSetup).loadPackageUploadReadback()).performAs(actor);
});
export const SubmitWorldPackageUploadOnce = () => Interaction.where('#actor selects the exact in-memory truncated ZIP and clicks installation once without trust changes', async actor => {
  const ability = actor.abilityTo(WorldPackageSetup);
  try { await ability.submitTruncatedPackage(); }
  finally { await notes().set('worldPackageUpload', ability.packageUploadEvidence()).performAs(actor); }
});
export const SelectWorldPackageUploadOperation = () => Interaction.where('#actor selects only the newly tracked operation from this upload', async actor => {
  const ability = actor.abilityTo(WorldPackageSetup);
  try { await ability.selectPackageUploadOperation(); }
  finally { await notes().set('worldPackageUpload', ability.packageUploadEvidence()).performAs(actor); }
});
export const ReadWorldPackageUploadReceipt = (refreshed: boolean) => Interaction.where('#actor reads the original full failed receipt and proves upload, inventory and active release identity', async actor => {
  const ability = actor.abilityTo(WorldPackageSetup);
  try { await ability.inspectPackageUpload(refreshed); }
  finally { await notes().set('worldPackageUpload', ability.packageUploadEvidence()).performAs(actor); }
});
export const ReadOriginalWorldPackageUpload = (refreshed: boolean) => Interaction.where('#actor reads only the r28 original status, result and upload with typed failures retained and zero submissions', async actor => {
  const ability = actor.abilityTo(WorldPackageSetup);
  try { await ability.readOriginalPackageUpload(refreshed); }
  finally { await notes().set('worldPackageUploadOriginal', ability.originalPackageUploadEvidence()).performAs(actor); }
});
export const InspectOriginalWorldPackageUploadUI = () => Interaction.where('#actor displays the exact original terminal identity, actual phase and full result or failure without recovery', async actor => {
  const ability = actor.abilityTo(WorldPackageSetup);
  try { await ability.inspectOriginalPackageUploadUI(); }
  finally { await notes().set('worldPackageUploadOriginal', ability.originalPackageUploadEvidence()).performAs(actor); }
});
export const PrepareOriginalWorldPackageRecovery = () => Interaction.where('#actor requires explicit repaired assembly evidence and rereads the original full admitted receipt before recovery', async actor => {
  const ability = actor.abilityTo(WorldPackageSetup);
  try { await ability.prepareOriginalPackageRecovery(); }
  finally {
    await notes().set('worldPackageUploadOriginal', ability.originalPackageUploadEvidence()).performAs(actor);
    await notes().set('worldPackageUploadRecovery', ability.originalPackageRecoveryEvidence()).performAs(actor);
  }
});
export const ResumeOriginalWorldPackageOnce = () => Interaction.where('#actor clicks only the normal original-operation Resume once and reads the same terminal identity without uploading', async actor => {
  const ability = actor.abilityTo(WorldPackageSetup);
  try { await ability.resumeOriginalPackageOnce(); }
  finally {
    await notes().set('worldPackageUploadOriginal', ability.originalPackageUploadEvidence()).performAs(actor);
    await notes().set('worldPackageUploadRecovery', ability.originalPackageRecoveryEvidence()).performAs(actor);
  }
});
