import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  LifecycleCatalogEntryIsPresent, LifecycleCatalogTitle, LifecycleSessionDeleted, LifecycleTitle,
  LifecycleTurnCancelled, LifecycleTurnCompleted, LifecycleTurnPersisted,
} from '../../questions/session-lifecycle.question.js';
import { EnterChat } from '../../tasks/chat.task.js';
import {
  CancelLifecycleTurn, CompleteLifecycleTurn, CreateLifecycleSession, DeleteLifecycleSession, OpenLifecycleSession,
  ReloadLifecycleCatalog, RenameLifecycleSession, RestoreLifecycleSession, VerifyLifecyclePersistence,
} from '../../tasks/session-lifecycle.task.js';

test('Chat 中重命名独占 OpenClaw 会话、发送并回读历史、停止运行，再从应用内删除', async ({ actor }) => {
  const failures: unknown[] = [];
  await actor.attemptsTo(EnterChat());
  try {
    await actor.attemptsTo(
      CreateLifecycleSession(),
      ReloadLifecycleCatalog(),
      RenameLifecycleSession(),
      Ensure.that(LifecycleCatalogTitle(), equals(LifecycleTitle())),
      OpenLifecycleSession(),
      CompleteLifecycleTurn(),
      Ensure.that(LifecycleTurnCompleted(), equals(true)),
      ReloadLifecycleCatalog(),
      Ensure.that(LifecycleCatalogTitle(), equals(LifecycleTitle())),
      OpenLifecycleSession(),
      VerifyLifecyclePersistence(),
      Ensure.that(LifecycleTurnPersisted(), equals(true)),
      CancelLifecycleTurn(),
      Ensure.that(LifecycleTurnCancelled(), equals(true)),
      DeleteLifecycleSession(),
      Ensure.that(LifecycleSessionDeleted(), equals(true)),
      ReloadLifecycleCatalog(),
      Ensure.that(LifecycleCatalogEntryIsPresent(), equals(false)),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(RestoreLifecycleSession()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Session lifecycle failed; cleanup errors retain the original failure');
});
