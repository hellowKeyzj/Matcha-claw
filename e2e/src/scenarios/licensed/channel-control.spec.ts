import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  SandboxBaselineWasRestored, SandboxConnectionWasObserved, SandboxDisconnectSettlement,
} from '../../questions/channel-control.question.js';
import { VerifyConfiguredSandboxControl } from '../../tasks/channel-control.task.js';
import { EnterChat } from '../../tasks/chat.task.js';

test('已配置飞书沙箱经公开控制确认连接，频道页同步状态，断开完成后精确恢复基线', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      VerifyConfiguredSandboxControl(),
      Ensure.that(SandboxConnectionWasObserved(), equals(true)),
      Ensure.that(SandboxDisconnectSettlement(), equals({
        admitted: true, status: 'succeeded', operation: 'disconnect', phase: 'complete', outcome: 'confirmed', sameAccount: true, redacted: true,
      })),
      Ensure.that(SandboxBaselineWasRestored(), equals(true)),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(EnterChat()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Channel control verification failed; cleanup errors retain the original failure');
});
