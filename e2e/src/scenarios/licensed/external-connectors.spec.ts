import { Ensure, equals, includes, not } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  ExternalConnectorCardIsVisible, ExternalConnectorCardText, ExternalConnectorDialogIsVisible, ExternalConnectorId,
  ExternalConnectorIsEnabled, ExternalConnectorName, ExternalConnectorNeedsSessionVerification, ExternalConnectorProbeReceipt,
  ExternalConnectorRejectedIsAbsent, ExternalConnectorRejection, ExternalConnectorRejectionIsVisible, ExternalConnectorRemoveReceipt,
  ExternalConnectorResource, ExternalConnectorStoreReceipt, ExternalConnectorsHeadingIsVisible,
} from '../../questions/external-connectors.question.js';
import { EnterChat } from '../../tasks/chat.task.js';
import {
  CloseExternalConnectorDialog, ConfirmRejectedExternalConnector, DeleteOwnedExternalConnector, OpenExternalConnectors,
  PrepareExternalConnector, ProbeExternalConnector, ReleaseExternalConnector, ReloadExternalConnector, SaveExternalConnector,
  SubmitRejectedExternalConnector,
} from '../../tasks/external-connectors.task.js';

test('外部 HTTP 连接器经真实 Electron→Rust 拒绝公开密钥、保存回读、探测不冒充已连接并精确删除', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      PrepareExternalConnector(),
      OpenExternalConnectors(),
      Ensure.that(ExternalConnectorsHeadingIsVisible(), equals(true)),
      SubmitRejectedExternalConnector(),
      Ensure.that(ExternalConnectorDialogIsVisible(), equals(true)),
      Ensure.that(ExternalConnectorRejectionIsVisible(), equals(true)),
      Ensure.that(ExternalConnectorRejection(), equals('External connector request is invalid')),
      Ensure.that(ExternalConnectorRejection(), not(includes('must-not-cross'))),
      ConfirmRejectedExternalConnector(),
      Ensure.that(ExternalConnectorRejectedIsAbsent(), equals(true)),
      SaveExternalConnector(),
      Ensure.that(ExternalConnectorStoreReceipt(), equals({ result: 'stored', created: true, projection: 'written', revisionApplied: true, exactPublicFact: true })),
      Ensure.that(ExternalConnectorName(), equals(ExternalConnectorResource().name)),
      Ensure.that(ExternalConnectorId(), equals(ExternalConnectorResource().id)),
      Ensure.that(ExternalConnectorIsEnabled(), equals(true)),
      ReloadExternalConnector(),
      Ensure.that(ExternalConnectorId(), equals(ExternalConnectorResource().id)),
      Ensure.that(ExternalConnectorName(), equals(ExternalConnectorResource().name)),
      Ensure.that(ExternalConnectorIsEnabled(), equals(true)),
      ProbeExternalConnector(),
      Ensure.that(ExternalConnectorProbeReceipt(), equals({ result: 'available', observation: 'unsupported', localConnections: 0, sameCallObservation: true })),
      Ensure.that(ExternalConnectorNeedsSessionVerification(), equals(true)),
      Ensure.that(ExternalConnectorCardText(), not(includes('探测可达'))),
      DeleteOwnedExternalConnector(),
      Ensure.that(ExternalConnectorRemoveReceipt(), equals({ result: 'removed', projection: 'written', tombstoned: true, revisionAdvanced: true, absent: true })),
      Ensure.that(ExternalConnectorCardIsVisible(), equals(false)),
    );
  } catch (error) { failures.push(error); }
  finally {
    for (const cleanup of [DeleteOwnedExternalConnector(), CloseExternalConnectorDialog(), EnterChat(), ReleaseExternalConnector()]) {
      try { await actor.attemptsTo(cleanup); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'External connector execution failed; cleanup errors retain the original failure');
});
