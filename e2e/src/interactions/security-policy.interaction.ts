import { Interaction, notes } from '@serenity-js/core';
import { UseSecurityPolicy } from '../abilities/security-policy.ability.js';

export const BorrowSecurityPolicy = () => Interaction.where('#actor borrows security policy resources from the shared Electron', async actor => {
  actor.abilityTo(UseSecurityPolicy);
  await notes().set('securityCleanup', 'none').performAs(actor);
  await notes().set('securityPolicyRestored', false).performAs(actor);
});

export const NavigateToSecurityPolicy = () => Interaction.where('#actor opens the current security UI route in the shared renderer', async actor => {
  await actor.abilityTo(UseSecurityPolicy).openPolicy();
});

export const RememberPublicSecurityPolicy = () => Interaction.where('#actor snapshots only the public security DTO', async actor => {
  const policy = actor.abilityTo(UseSecurityPolicy);
  await policy.rememberPolicy();
  await notes().set('securityOriginalPatterns', policy.originalPatterns()).performAs(actor);
  await notes().set('securityDraftPatterns', policy.draftPatterns()).performAs(actor);
});

export const PrepareSecuritySave = (purpose: 'change' | 'restore') => Interaction.where(`#actor records the public call boundary for security ${purpose}`, async actor => {
  await actor.abilityTo(UseSecurityPolicy).beginSave(purpose);
});

export const ConfirmSecuritySave = () => Interaction.where('#actor reads this UI save call until runtime delivery is confirmed', async actor => {
  const effect = await actor.abilityTo(UseSecurityPolicy).confirmSave();
  await notes().set('securitySaveEffect', effect).performAs(actor);
});

export const ObserveSecurityDesiredChange = () => Interaction.where('#actor reads desired policy separately from runtime delivery', async actor => {
  const matches = await actor.abilityTo(UseSecurityPolicy).observeDesiredChange();
  await notes().set('securityDesiredChange', matches).performAs(actor);
});

export const PlanSecurityCleanup = () => Interaction.where('#actor reconciles its security write before deciding cleanup', async actor => {
  const action = await actor.abilityTo(UseSecurityPolicy).prepareCleanup();
  await notes().set('securityCleanup', action).performAs(actor);
});

export const ObserveSecurityRestoration = () => Interaction.where('#actor verifies exact public security DTO restoration', async actor => {
  const restored = await actor.abilityTo(UseSecurityPolicy).observeExactRestoration();
  await notes().set('securityPolicyRestored', restored).performAs(actor);
});
