import { Interaction, notes } from '@serenity-js/core';
import { WorldPackageTrust } from '../abilities/world-package-trust.ability.js';

export const CaptureWorldTrustPolicy = () => Interaction.where('#actor reads the complete public policy baseline and prepares only a one-time public draft identity', async actor => {
  await notes().set('worldTrustBaseline', await actor.abilityTo(WorldPackageTrust).capture()).performAs(actor);
});
export const RejectInvalidWorldTrustKeys = () => Interaction.where('#actor submits invalid hex and short/long public keys only to the local draft form', async actor => {
  await notes().set('worldTrustInvalid', await actor.abilityTo(WorldPackageTrust).rejectInvalid()).performAs(actor);
});
export const AddWorldTrustDraft = () => Interaction.where('#actor adds the RFC 8032 public key only to the UI draft with both flags false', async actor => {
  await notes().set('worldTrustDraft', await actor.abilityTo(WorldPackageTrust).addDraft()).performAs(actor);
});
export const RejectDuplicateWorldTrustKey = () => Interaction.where('#actor verifies the same publisher plus key ID cannot produce a second draft row', async actor => {
  await notes().set('worldTrustDuplicate', await actor.abilityTo(WorldPackageTrust).rejectDuplicate()).performAs(actor);
});
export const RemoveWorldTrustDraft = () => Interaction.where('#actor removes only its own new draft root and checks the original no-difference state', async actor => {
  await notes().set('worldTrustRemoved', await actor.abilityTo(WorldPackageTrust).removeDraft()).performAs(actor);
});
export const ReviewAndCancelWorldTrust = () => Interaction.where('#actor reads the World root warnings and cancels the application dialog without ever selecting final Confirm', async actor => {
  await notes().set('worldTrustConfirmation', await actor.abilityTo(WorldPackageTrust).reviewAndCancel()).performAs(actor);
});
export const ReadWorldTrustAfterCancel = () => Interaction.where('#actor reads the complete public policy after Cancel without issuing any mutation API', async actor => {
  await notes().set('worldTrustAfterCancel', await actor.abilityTo(WorldPackageTrust).afterCancel()).performAs(actor);
});
export const ReadWorldTrustAfterRefresh = () => Interaction.where('#actor checks the draft vanished after normal reload and reads the complete public policy again', async actor => {
  await notes().set('worldTrustAfterRefresh', await actor.abilityTo(WorldPackageTrust).afterRefresh()).performAs(actor);
});
