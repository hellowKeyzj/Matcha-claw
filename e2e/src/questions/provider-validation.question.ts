import { Question, notes } from '@serenity-js/core';
import { Attribute, Text, Value } from '@serenity-js/web';
import { ProviderValidationPage } from '../pages/provider-validation.page.js';

type ProviderValidationNotes = {
  providerValidationLabel: string;
  providerValidationModelId: string;
  providerValidationPublicFieldsOnly: boolean;
  providerValidationEmptyKey: { unchanged: boolean; publicFieldsOnly: boolean };
  providerValidationAccount: { provider: string; authMode: string; enabled: boolean; publicFieldsOnly: boolean; credentialStatusOnly: boolean; hasNoStoredKey: boolean };
  providerValidationModel: { count: number; modelMatches: boolean; chatOnly: boolean; otherModelsUnchanged: boolean };
  providerValidationCleanupTarget: boolean;
  providerValidationRestored: boolean;
};

export const ProviderValidationLabel = () => notes<ProviderValidationNotes>().get('providerValidationLabel');
export const ProviderValidationModelId = () => notes<ProviderValidationNotes>().get('providerValidationModelId');
export const ProviderValidationWasPrepared = () => notes<ProviderValidationNotes>().has('providerValidationLabel');
export const ProviderValidationPublicFieldsOnly = () => notes<ProviderValidationNotes>().get('providerValidationPublicFieldsOnly');
export const ProviderValidationEmptyKeyState = () => notes<ProviderValidationNotes>().get('providerValidationEmptyKey');
export const ProviderValidationAccountState = () => notes<ProviderValidationNotes>().get('providerValidationAccount');
export const ProviderValidationModelState = () => notes<ProviderValidationNotes>().get('providerValidationModel');
export const ProviderValidationHasCleanupTarget = () => notes<ProviderValidationNotes>().get('providerValidationCleanupTarget');
export const ProviderValidationWasRestored = () => notes<ProviderValidationNotes>().get('providerValidationRestored');
export const ProviderValidationKeyCount = () => ProviderValidationPage.apiKeys.count();
export const ProviderValidationKeyType = () => Attribute.called('type').of(ProviderValidationPage.apiKey);
export const ProviderValidationKeyValue = () => Value.of(ProviderValidationPage.apiKey);
export const ProviderValidationKeyLabelCount = () => ProviderValidationPage.apiKeyLabels.count();
export const ProviderValidationSavedModelValue = () => Value.of(ProviderValidationPage.modelInputs(ProviderValidationLabel()).first());
export const ProviderValidationBodyText = () => Text.of(ProviderValidationPage.body);
export const ProviderValidationInvalidKeyIsVisible = () => ProviderValidationPage.invalidKey.isVisible();
export const ProviderValidationSubmissionHasSettled = () => Question.about('the provider form closed or a product add failure is visible', async actor =>
  !(await actor.answer(ProviderValidationPage.dialog.isVisible())) || await actor.answer(ProviderValidationPage.addFailure.isVisible()),
);
export const ProviderValidationDuplicateWasRejected = () => Question.about('the duplicate model ID has the exact validation error', async actor => {
  const modelId = await actor.answer(ProviderValidationModelId());
  const error = await actor.answer(Text.of(ProviderValidationPage.modelError(ProviderValidationLabel())));
  return error === `模型 ID "${modelId}" 重复` || error === `Model ID "${modelId}" appears twice`;
});
