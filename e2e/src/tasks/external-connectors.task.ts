import { Ensure, equals, not } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Click, Enter, Navigate, Select, isEnabled, isVisible } from '@serenity-js/web';
import {
  ArmExternalConnectorSubmission, CheckExternalConnectorCleanup, ReadConnectorProbe, ReadOriginalExternalConnectorRuntime, ReadRejectedConnectorAbsence,
  ReadRemovedConnector, ReadStoredConnector, ReleaseExternalConnectorEndpoint, RememberExternalConnectorRuntime, ReserveExternalConnector,
} from '../interactions/external-connectors.interaction.js';
import { ExternalConnectorsPage } from '../pages/external-connectors.page.js';
import {
  ExternalConnectorCleanupIsRequired, ExternalConnectorResource, ExternalConnectorRuntimeIsAvailable, ExternalConnectorRuntimeIsSelected,
  ExternalConnectorRuntimeName, ExternalConnectorRuntimeWasRemembered, ExternalConnectorsHasSettled, ExternalConnectorsIsReady,
} from '../questions/external-connectors.question.js';
import { EnterChat } from './chat.task.js';

export const PrepareExternalConnector = () => Task.where('#actor prepares an exclusive connector without reading profile/configuration', ReserveExternalConnector());

export const OpenExternalConnectors = () => Task.where('#actor opens the current connectors UI from local Chat',
  EnterChat(),
  Click.on(ExternalConnectorsPage.agentNavigation),
  Wait.until(ExternalConnectorsPage.connectorNavigation, isVisible()),
  Check.whether(ExternalConnectorRuntimeWasRemembered(), equals(true)).andIfSo(
    ReadOriginalExternalConnectorRuntime(),
    Wait.upTo(Duration.ofSeconds(45)).until(ExternalConnectorRuntimeIsAvailable(), equals(true)),
    Check.whether(ExternalConnectorsPage.runtime(ExternalConnectorRuntimeName()), isVisible()).andIfSo(
      Click.on(ExternalConnectorsPage.runtime(ExternalConnectorRuntimeName())),
    ),
    Wait.until(ExternalConnectorRuntimeIsSelected(), equals(true)),
    RememberExternalConnectorRuntime(),
  ),
  Click.on(ExternalConnectorsPage.connectorNavigation),
  Wait.until(ExternalConnectorsPage.heading, isVisible()),
  Wait.upTo(Duration.ofSeconds(45)).until(ExternalConnectorsHasSettled(), equals(true)),
  Ensure.that(ExternalConnectorsIsReady(), equals(true)),
  RememberExternalConnectorRuntime(),
  Enter.theValue('').into(ExternalConnectorsPage.search),
  Select.value('all').from(ExternalConnectorsPage.kindFilter),
  Select.value('all').from(ExternalConnectorsPage.statusFilter),
);

const FillOwnedHttpConnector = (rejected: boolean) => Task.where('#actor fills only the reserved secret-free HTTP resource',
  Click.on(ExternalConnectorsPage.add),
  Wait.until(ExternalConnectorsPage.dialog, isVisible()),
  Enter.theValue(rejected ? ExternalConnectorResource().rejectedId : ExternalConnectorResource().id).into(ExternalConnectorsPage.id),
  Select.value('http').from(ExternalConnectorsPage.kind),
  Enter.theValue(ExternalConnectorResource().name).into(ExternalConnectorsPage.name),
  Enter.theValue(ExternalConnectorResource().baseUrl).into(ExternalConnectorsPage.baseUrl),
);

export const SubmitRejectedExternalConnector = () => Task.where('#actor submits a non-secret canary under the forbidden Authorization header',
  FillOwnedHttpConnector(true),
  Enter.theValue('Authorization=must-not-cross').into(ExternalConnectorsPage.headers),
  ArmExternalConnectorSubmission('rejection'),
  Click.on(ExternalConnectorsPage.create),
  Wait.until(ExternalConnectorsPage.rejection, isVisible()),
);

export const ConfirmRejectedExternalConnector = () => Task.where('#actor confirms the rejection did not persist and cancels the dialog',
  ReadRejectedConnectorAbsence(),
  Click.on(ExternalConnectorsPage.cancel),
  Wait.until(ExternalConnectorsPage.dialog, not(isVisible())),
);

export const SaveExternalConnector = () => Task.where('#actor saves the owned HTTP connector exactly once through Electron and Rust',
  FillOwnedHttpConnector(false),
  ArmExternalConnectorSubmission('upsert'),
  Click.on(ExternalConnectorsPage.create),
  ReadStoredConnector(),
  Wait.until(ExternalConnectorsPage.dialog, not(isVisible())),
  Wait.until(ExternalConnectorsPage.card(ExternalConnectorResource().name), isVisible()),
);

export const ReloadExternalConnector = () => Task.where('#actor reloads the real connector UI without repeating the mutation',
  EnterChat(),
  Navigate.reloadPage(),
  OpenExternalConnectors(),
  Wait.until(ExternalConnectorsPage.card(ExternalConnectorResource().name), isVisible()),
);

export const ProbeExternalConnector = () => Task.where('#actor requests one UI probe and reads its real terminal observation',
  Wait.until(ExternalConnectorsPage.probe(ExternalConnectorResource().name), isEnabled()),
  ArmExternalConnectorSubmission('probe'),
  Click.on(ExternalConnectorsPage.probe(ExternalConnectorResource().name)),
  ReadConnectorProbe(),
  Wait.upTo(Duration.ofSeconds(30)).until(ExternalConnectorsPage.unsupported(ExternalConnectorResource().name), isVisible()),
);

export const CloseExternalConnectorDialog = () => Task.where('#actor dismisses only this scenario connector form',
  Check.whether(ExternalConnectorsPage.dialog, isVisible()).andIfSo(Click.on(ExternalConnectorsPage.cancel)),
);

export const DeleteOwnedExternalConnector = () => Task.where('#actor removes only the confirmed owned connector; unresolved calls are never retried',
  CheckExternalConnectorCleanup(),
  Check.whether(ExternalConnectorCleanupIsRequired(), equals(true)).andIfSo(
    CloseExternalConnectorDialog(),
    Wait.until(ExternalConnectorsPage.remove(ExternalConnectorResource().name), isEnabled()),
    ArmExternalConnectorSubmission('remove'),
    Click.on(ExternalConnectorsPage.remove(ExternalConnectorResource().name)),
    ReadRemovedConnector(),
    Wait.until(ExternalConnectorsPage.card(ExternalConnectorResource().name), not(isVisible())),
  ),
);

export const ReleaseExternalConnector = () => Task.where('#actor releases the owned loopback endpoint even when business outcome is unresolved', ReleaseExternalConnectorEndpoint());
