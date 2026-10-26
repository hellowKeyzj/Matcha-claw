import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  FixedPngWasStaged, PublicPngCustodyExposure, PublicPngReplayReceipt, PublicPngSendReceipt,
  PublicSessionCatalogIsReady, PublicSessionWasCreated, PublicTextSendReceipt,
} from '../../questions/session-capabilities.question.js';
import {
  AttemptPublicAttachmentReplay, CreatePublicSession, DeliverPublicFixedPng,
  PreparePublicFixedPng, RestorePublicAttachmentSession, SendPublicSessionBaseline,
} from '../../tasks/session-capabilities.task.js';
import { EnterChat } from '../../tasks/chat.task.js';

test('公开能力合同：文本与固定 PNG 完成真实 turn 后持久化，回执脱敏且拒绝附件重放', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      EnterChat(),
      CreatePublicSession(),
      Ensure.that(PublicSessionCatalogIsReady(), equals(true)),
      Ensure.that(PublicSessionWasCreated(), equals(true)),
      PreparePublicFixedPng(),
      Ensure.that(FixedPngWasStaged(), equals(true)),
      SendPublicSessionBaseline(),
      Ensure.that(PublicTextSendReceipt(), equals({ admitted: true, hasRunId: true, completed: true, persisted: true })),
      DeliverPublicFixedPng(),
      Ensure.that(PublicPngSendReceipt(), equals({ admitted: true, hasRunId: true, completed: true, persisted: true })),
      Ensure.that(PublicPngCustodyExposure(), equals({ stagingPath: false, mediaReference: false, fullPng: false, pngPrefix: false })),
      AttemptPublicAttachmentReplay(),
      Ensure.that(PublicPngReplayReceipt(), equals({ ok: true, status: 500, httpOk: false, successIsFalse: true, fixedPublicError: true })),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(RestorePublicAttachmentSession()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Public attachment execution failed; cleanup errors retain the original failure');
});

test('公开能力合同：纯文本完成真实 turn 后完整持久化', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      EnterChat(),
      CreatePublicSession(),
      Ensure.that(PublicSessionCatalogIsReady(), equals(true)),
      Ensure.that(PublicSessionWasCreated(), equals(true)),
      SendPublicSessionBaseline(),
      Ensure.that(PublicTextSendReceipt(), equals({ admitted: true, hasRunId: true, completed: true, persisted: true })),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(RestorePublicAttachmentSession()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Public text execution failed; cleanup errors retain the original failure');
});
