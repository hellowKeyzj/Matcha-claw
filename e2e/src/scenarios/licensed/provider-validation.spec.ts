import { Ensure, equals, includes, not } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  ProviderValidationAccountState, ProviderValidationBodyText, ProviderValidationDuplicateWasRejected,
  ProviderValidationEmptyKeyState, ProviderValidationInvalidKeyIsVisible, ProviderValidationKeyCount, ProviderValidationKeyLabelCount,
  ProviderValidationKeyType, ProviderValidationKeyValue, ProviderValidationModelId, ProviderValidationModelState,
  ProviderValidationPublicFieldsOnly, ProviderValidationSavedModelValue,
} from '../../questions/provider-validation.question.js';
import {
  DeleteProviderValidationAccount, DiscardProviderValidationModelDraft, DismissProviderValidationDialog, OpenProviderValidationCustomForm,
  OpenProviderValidationLocalForm, RejectProviderValidationDuplicateModel, RejectProviderValidationEmptyKey,
  SaveProviderValidationModel, StartProviderValidation, SubmitProviderValidationLocalAccount,
} from '../../tasks/provider-validation.task.js';

test('模型页自定义聊天提供商拒绝空 API key，密码输入与公开账号 DTO 不泄露凭据', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      StartProviderValidation(),
      Ensure.that(ProviderValidationPublicFieldsOnly(), equals(true)),
      OpenProviderValidationCustomForm(),
      Ensure.that(ProviderValidationKeyType(), equals('password')),
      Ensure.that(ProviderValidationKeyValue(), equals('')),
      RejectProviderValidationEmptyKey(),
      Ensure.that(ProviderValidationInvalidKeyIsVisible(), equals(true)),
      Ensure.that(ProviderValidationKeyLabelCount(), equals(1)),
      Ensure.that(ProviderValidationBodyText(), not(includes('sk-'))),
      Ensure.that(ProviderValidationEmptyKeyState(), equals({ unchanged: true, publicFieldsOnly: true })),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(DismissProviderValidationDialog());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Provider form cleanup failed; the original failure is retained');
    }
  }
});

test('模型页创建免 key Ollama 账号、保存模型草稿并拒绝重复 ID，精确删除自建资源', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      StartProviderValidation(),
      Ensure.that(ProviderValidationPublicFieldsOnly(), equals(true)),
      OpenProviderValidationLocalForm(),
      Ensure.that(ProviderValidationKeyCount(), equals(0)),
      SubmitProviderValidationLocalAccount(),
      Ensure.that(ProviderValidationAccountState(), equals({
        provider: 'ollama', authMode: 'local', enabled: true, publicFieldsOnly: true, credentialStatusOnly: true, hasNoStoredKey: true,
      })),
      SaveProviderValidationModel(),
      Ensure.that(ProviderValidationSavedModelValue(), equals(ProviderValidationModelId())),
      Ensure.that(ProviderValidationModelState(), equals({ count: 1, modelMatches: true, chatOnly: true, otherModelsUnchanged: true })),
      RejectProviderValidationDuplicateModel(),
      Ensure.that(ProviderValidationDuplicateWasRejected(), equals(true)),
      Ensure.that(ProviderValidationModelState(), equals({ count: 1, modelMatches: true, chatOnly: true, otherModelsUnchanged: true })),
      DiscardProviderValidationModelDraft(),
      Ensure.that(ProviderValidationSavedModelValue(), equals(ProviderValidationModelId())),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await actor.attemptsTo(DeleteProviderValidationAccount());
    } catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Provider validation cleanup could not confirm its owned resource; the original failure is retained');
    }
  }
});
