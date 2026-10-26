import { Ensure, equals } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Attribute, Click, Enter, isEnabled, isVisible } from '@serenity-js/web';
import {
  ConfirmProviderValidationAccount, ConfirmProviderValidationCleanup, FindProviderValidationCleanupTarget,
  MarkProviderValidationDeletion, MarkProviderValidationSubmission, ObserveProviderValidationEmptyKey,
  ObserveProviderValidationModel, PrepareProviderValidation, RequireProviderValidationSubmissionSuccess,
} from '../interactions/provider-validation.interaction.js';
import { ProviderValidationPage } from '../pages/provider-validation.page.js';
import {
  ProviderValidationHasCleanupTarget, ProviderValidationLabel, ProviderValidationModelId,
  ProviderValidationSubmissionHasSettled, ProviderValidationWasPrepared, ProviderValidationWasRestored,
} from '../questions/provider-validation.question.js';
import { EnterChat } from './chat.task.js';

export const StartProviderValidation = () => Task.where('#actor enters Models from Chat and records the public starting state',
  EnterChat(),
  Click.on(ProviderValidationPage.navigation),
  Wait.until(ProviderValidationPage.heading, isVisible()),
  Wait.upTo(Duration.ofSeconds(45)).until(ProviderValidationPage.refresh, isEnabled()),
  PrepareProviderValidation(),
);

const OpenProviderValidationDialog = () => Task.where('#actor opens the provider brand picker in the Models management card',
  Click.on(ProviderValidationPage.add),
  Wait.until(ProviderValidationPage.dialog, isVisible()),
);

export const OpenProviderValidationCustomForm = () => Task.where('#actor selects the current custom chat-provider form without entering a credential',
  OpenProviderValidationDialog(),
  Click.on(ProviderValidationPage.custom),
  Wait.until(ProviderValidationPage.chatProvider, isVisible()),
  Wait.until(ProviderValidationPage.protocol, isVisible()),
  Wait.until(ProviderValidationPage.apiKey, isVisible()),
);

export const RejectProviderValidationEmptyKey = () => Task.where('#actor submits the empty API key and reads the unchanged public catalog',
  Click.on(ProviderValidationPage.submit),
  Wait.until(ProviderValidationPage.invalidKey, isVisible()),
  ObserveProviderValidationEmptyKey(),
);

export const OpenProviderValidationLocalForm = () => Task.where('#actor selects Ollama and names an independent local account without supplying a key',
  OpenProviderValidationDialog(),
  Click.on(ProviderValidationPage.ollama),
  Wait.until(ProviderValidationPage.baseUrl, isVisible()),
  Enter.theValue(ProviderValidationLabel()).into(ProviderValidationPage.name),
);

export const SubmitProviderValidationLocalAccount = () => Task.where('#actor creates the no-key local account once through the UI and confirms its public UUID',
  MarkProviderValidationSubmission(),
  Click.on(ProviderValidationPage.submit),
  Wait.upTo(Duration.ofSeconds(60)).until(ProviderValidationSubmissionHasSettled(), equals(true)),
  RequireProviderValidationSubmissionSuccess(),
  Wait.until(ProviderValidationPage.dialog.isVisible(), equals(false)),
  ConfirmProviderValidationAccount(),
  Wait.until(ProviderValidationPage.header(ProviderValidationLabel()), isVisible()),
);

const ExpandProviderValidationAccount = () => Task.where('#actor expands only this case\'s local provider card',
  Check.whether(Attribute.called('aria-expanded').of(ProviderValidationPage.header(ProviderValidationLabel())), equals('false')).andIfSo(
    Click.on(ProviderValidationPage.header(ProviderValidationLabel())),
  ),
);

export const SaveProviderValidationModel = () => Task.where('#actor adds a model draft, saves changes, and reads the committed catalog',
  ExpandProviderValidationAccount(),
  Wait.until(ProviderValidationPage.addModel(ProviderValidationLabel()), isEnabled()),
  Click.on(ProviderValidationPage.addModel(ProviderValidationLabel())),
  Enter.theValue(ProviderValidationModelId()).into(ProviderValidationPage.modelInputs(ProviderValidationLabel()).last()),
  Click.on(ProviderValidationPage.saveModels(ProviderValidationLabel())),
  Wait.upTo(Duration.ofSeconds(60)).until(ProviderValidationPage.saveModels(ProviderValidationLabel()).isPresent(), equals(false)),
  Wait.until(ProviderValidationPage.modelInputs(ProviderValidationLabel()).first(), isVisible()),
  ObserveProviderValidationModel(),
);

export const RejectProviderValidationDuplicateModel = () => Task.where('#actor submits a duplicate model draft and reads the still-single committed model',
  Click.on(ProviderValidationPage.addModel(ProviderValidationLabel())),
  Enter.theValue(ProviderValidationModelId()).into(ProviderValidationPage.modelInputs(ProviderValidationLabel()).last()),
  Click.on(ProviderValidationPage.saveModels(ProviderValidationLabel())),
  Wait.until(ProviderValidationPage.modelError(ProviderValidationLabel()), isVisible()),
  ObserveProviderValidationModel(),
);

export const DiscardProviderValidationModelDraft = () => Task.where('#actor discards only this account\'s unsaved model draft',
  Check.whether(ProviderValidationPage.discardModels(ProviderValidationLabel()), isVisible()).andIfSo(
    Click.on(ProviderValidationPage.discardModels(ProviderValidationLabel())),
    Wait.until(ProviderValidationPage.discardModels(ProviderValidationLabel()).isPresent(), equals(false)),
  ),
);

export const DismissProviderValidationDialog = () => Task.where('#actor closes the unfinished provider form without saving it',
  Check.whether(ProviderValidationPage.dialog, isVisible()).andIfSo(
    Click.on(ProviderValidationPage.cancel),
    Wait.until(ProviderValidationPage.dialog.isPresent(), equals(false)),
  ),
);

export const DeleteProviderValidationAccount = () => Task.where('#actor removes only this case\'s public-verified UUID and confirms exact catalog restoration',
  DismissProviderValidationDialog(),
  Check.whether(ProviderValidationWasPrepared(), equals(true)).andIfSo(
    FindProviderValidationCleanupTarget(),
    Check.whether(ProviderValidationHasCleanupTarget(), equals(true)).andIfSo(
      Wait.until(ProviderValidationPage.header(ProviderValidationLabel()), isVisible()),
      ExpandProviderValidationAccount(),
      DiscardProviderValidationModelDraft(),
      Wait.upTo(Duration.ofSeconds(60)).until(ProviderValidationPage.delete(ProviderValidationLabel()), isEnabled()),
      MarkProviderValidationDeletion(),
      Click.on(ProviderValidationPage.delete(ProviderValidationLabel())),
      Wait.upTo(Duration.ofSeconds(60)).until(ProviderValidationPage.header(ProviderValidationLabel()).isPresent(), equals(false)),
    ),
    ConfirmProviderValidationCleanup(),
    Ensure.that(ProviderValidationWasRestored(), equals(true)),
  ),
);
