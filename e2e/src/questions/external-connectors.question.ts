import { Question, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { ExternalConnectorsPage } from '../pages/external-connectors.page.js';

export const ExternalConnectorResource = () => notes<{ externalConnectorResource: { id: string; rejectedId: string; name: string; baseUrl: string } }>().get('externalConnectorResource');
export const ExternalConnectorsHeadingIsVisible = () => ExternalConnectorsPage.heading.isVisible();
export const ExternalConnectorRuntimeWasRemembered = () => notes().has('externalConnectorRuntimeName');
export const ExternalConnectorRuntimeName = () => notes<{ externalConnectorRuntimeName: string }>().get('externalConnectorRuntimeName');
export const ExternalConnectorRuntimeIsAvailable = () => Question.about('the original connector management runtime is available in the UI', async actor =>
  await actor.answer(ExternalConnectorsPage.runtime(ExternalConnectorRuntimeName()).isVisible())
  || await actor.answer(ExternalConnectorsPage.onlyRuntime(ExternalConnectorRuntimeName()).isVisible()),
);
export const ExternalConnectorRuntimeIsSelected = () => Question.about('the original connector management runtime is selected in the UI', async actor =>
  await actor.answer(ExternalConnectorsPage.onlyRuntime(ExternalConnectorRuntimeName()).isPresent())
  || (await actor.answer(ExternalConnectorsPage.runtime(ExternalConnectorRuntimeName()).isPresent())
    && await actor.answer(Attribute.called('aria-checked').of(ExternalConnectorsPage.runtime(ExternalConnectorRuntimeName()))) === 'true'),
);
export const ExternalConnectorsHasSettled = () => Question.about('Connectors has a ready catalog count or an explicit error', async actor =>
  await actor.answer(ExternalConnectorsPage.readyCount.isVisible()) || await actor.answer(ExternalConnectorsPage.errors.count()) > 0,
);
export const ExternalConnectorsIsReady = () => Question.about('Connectors loaded its current scope without hiding an error', async actor =>
  await actor.answer(ExternalConnectorsPage.readyCount.isVisible()) && await actor.answer(ExternalConnectorsPage.errors.count()) === 0,
);
export const ExternalConnectorDialogIsVisible = () => ExternalConnectorsPage.dialog.isVisible();
export const ExternalConnectorRejection = () => Text.of(ExternalConnectorsPage.rejection);
export const ExternalConnectorRejectionIsVisible = () => ExternalConnectorsPage.rejection.isVisible();
export const ExternalConnectorRejectedIsAbsent = () => notes<{ externalConnectorRejectedAbsent: boolean }>().get('externalConnectorRejectedAbsent');
export const ExternalConnectorCardIsVisible = () => ExternalConnectorsPage.card(ExternalConnectorResource().name).isVisible();
export const ExternalConnectorId = () => Text.of(ExternalConnectorsPage.idForName(ExternalConnectorResource().name));
export const ExternalConnectorName = () => Text.of(ExternalConnectorsPage.nameForName(ExternalConnectorResource().name));
export const ExternalConnectorIsEnabled = () => ExternalConnectorsPage.enabled(ExternalConnectorResource().name).isVisible();
export const ExternalConnectorNeedsSessionVerification = () => ExternalConnectorsPage.unsupported(ExternalConnectorResource().name).isVisible();
export const ExternalConnectorCardText = () => Text.of(ExternalConnectorsPage.card(ExternalConnectorResource().name));
export const ExternalConnectorStoreReceipt = () => notes().get('externalConnectorStored');
export const ExternalConnectorProbeReceipt = () => notes().get('externalConnectorProbe');
export const ExternalConnectorRemoveReceipt = () => notes().get('externalConnectorRemoved');
export const ExternalConnectorCleanupIsRequired = () => notes<{ externalConnectorCleanupRequired: boolean }>().get('externalConnectorCleanupRequired');
