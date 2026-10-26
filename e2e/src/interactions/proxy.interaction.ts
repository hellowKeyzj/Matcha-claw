import { Interaction, notes } from '@serenity-js/core';
import { UseProxy } from '../abilities/proxy.ability.js';

export const RememberProxyBaseline = () => Interaction.where('#actor reserves one owned proxy destination and remembers the exact public settings baseline', async actor => {
  await notes().set('proxyResource', await actor.abilityTo(UseProxy).prepare()).performAs(actor);
});

export const ArmProxySave = (purpose: 'enabled' | 'disabled' | 'restore') => Interaction.where(`#actor arms one ${purpose} proxy save without retrying unresolved writes`, async actor => {
  await actor.abilityTo(UseProxy).beginSave(purpose);
});

export const ConfirmProxySave = () => Interaction.where('#actor observes the unique settings call and exact canonical readback without resubmitting it', async actor => {
  await notes().set('proxySaveReceipt', await actor.abilityTo(UseProxy).confirmSave()).performAs(actor);
});

export const ReadConfirmedProxySettings = () => Interaction.where('#actor reads back all six confirmed public settings fields', async actor => {
  await notes().set('proxyPublicSettingsMatch', await actor.abilityTo(UseProxy).observeCurrent()).performAs(actor);
});

export const PlanProxyCleanup = () => Interaction.where('#actor permits exact proxy restoration only after a confirmed owned change', async actor => {
  await notes().set('proxyCleanupAction', await actor.abilityTo(UseProxy).prepareCleanup()).performAs(actor);
});

export const CloseProxyEndpoint = () => Interaction.where('#actor closes only this case owned loopback destination even after a UI recovery failure', async actor => {
  await actor.abilityTo(UseProxy).close();
});
