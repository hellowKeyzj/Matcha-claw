import { Interaction, notes } from '@serenity-js/core';
import { WorldActions } from '../abilities/world-actions.ability.js';

const act = (description: string, action: (ability: WorldActions) => Promise<unknown>) => Interaction.where(description, async actor => {
  const ability = actor.abilityTo(WorldActions);
  try { await action(ability); }
  finally { await notes().set('worldActions', ability.evidence()).performAs(actor); }
});

export const ReadWorldActionBinding = () => act('#actor reads only the explicit public scratch action binding, refusing unbound input before any proposal', ability => ability.prepare());
export const ReadWorldActionPrerequisites = () => act('#actor checks exact existing action, target type and Source definitions through public read admission', ability => ability.inspectPrerequisites());
export const ConfigureOriginalWorldAction = () => act('#actor selects the real current object and enters only the unchanged bound action parameters through UI', ability => ability.chooseTarget());
export const MarkWorldAction = (kind: 'proposal' | 'approval' | 'action') => act(`#actor retains the single original ${kind} request and observes its Operation hint before clicking once`, ability => ability.arm(kind));
export const ConfirmWorldAction = (kind: 'proposal' | 'approval' | 'action') => act(`#actor reads the exact original ${kind} Operation, never treating accepted or queued as completion`, ability => ability.confirm(kind));
export const ReviewOriginalWorldProposal = () => act('#actor reviews the unchanged proposal request, impact and real approval expiry in the application', ability => ability.reviewProposal());
export const ReviewOriginalWorldApproval = () => act('#actor reads the exact in-app approval binding without creating another approval', ability => ability.reviewApproval());
export const VerifyOriginalWorldAction = () => act('#actor checks same-intent causal Source receipts, independent Verifier and a separate authoritative expected-result read', ability => ability.verifyResult());
export const PreserveWorldActionCustody = () => act('#actor releases only the owned observer, retaining all rejected/unknown custody and durable history without retry or recovery', ability => ability.preserve());
