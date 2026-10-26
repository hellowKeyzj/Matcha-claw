import { Interaction, notes } from '@serenity-js/core';
import { Text } from '@serenity-js/web';
import { ProviderValidation } from '../abilities/provider-validation.ability.js';
import { ProviderValidationPage } from '../pages/provider-validation.page.js';

export const PrepareProviderValidation = () => Interaction.where('#actor records public provider facts and allocates unique resource names', async actor => {
  const validation = actor.abilityTo(ProviderValidation);
  const prepared = await validation.prepare();
  await notes().set('providerValidationLabel', prepared.label).performAs(actor);
  await notes().set('providerValidationModelId', prepared.modelId).performAs(actor);
  await notes().set('providerValidationPublicFieldsOnly', prepared.publicFieldsOnly).performAs(actor);
});

export const ObserveProviderValidationEmptyKey = () => Interaction.where('#actor reads the public account catalog after empty-key rejection', async actor => {
  const state = await actor.abilityTo(ProviderValidation).observeEmptyKeyRejection();
  await notes().set('providerValidationEmptyKey', state).performAs(actor);
});

export const MarkProviderValidationSubmission = () => Interaction.where('#actor records the single local-account submission', async actor => {
  actor.abilityTo(ProviderValidation).markSubmitted();
});

export const RequireProviderValidationSubmissionSuccess = () => Interaction.where('#actor retains any product rejection of the no-key account instead of retrying it', async actor => {
  if (await actor.answer(ProviderValidationPage.addFailure.isVisible())) {
    throw new Error(`The no-key local provider account was not created: ${await actor.answer(Text.of(ProviderValidationPage.addFailure))}`);
  }
});

export const MarkProviderValidationDeletion = () => Interaction.where('#actor records the single deletion of the confirmed provider UUID', async actor => {
  actor.abilityTo(ProviderValidation).markDeletionSubmitted();
});

export const ConfirmProviderValidationAccount = () => Interaction.where('#actor confirms the unique local account using public facts only', async actor => {
  const account = await actor.abilityTo(ProviderValidation).confirmAccount();
  await notes().set('providerValidationAccount', account).performAs(actor);
});

export const ObserveProviderValidationModel = () => Interaction.where('#actor reads the committed model catalog without changing routing', async actor => {
  const model = await actor.abilityTo(ProviderValidation).observeModel();
  await notes().set('providerValidationModel', model).performAs(actor);
});

export const FindProviderValidationCleanupTarget = () => Interaction.where('#actor binds cleanup to this case\'s public account identity', async actor => {
  const present = await actor.abilityTo(ProviderValidation).findCleanupTarget();
  await notes().set('providerValidationCleanupTarget', present).performAs(actor);
});

export const ConfirmProviderValidationCleanup = () => Interaction.where('#actor checks public accounts and models were restored exactly', async actor => {
  const restored = await actor.abilityTo(ProviderValidation).confirmRestored();
  await notes().set('providerValidationRestored', restored).performAs(actor);
});
