import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  ElectronStartupOutcome, OpenClawSettingsStatus, PublicOpenClawReadiness, PublicRuntimeHostReadiness, RuntimeHostSettingsStatus,
} from '../../questions/runtime-lifecycle.question.js';
import { EnterChat } from '../../tasks/chat.task.js';
import { ObservePublicRuntimeReadiness, OpenRuntimeLifecycleSettings } from '../../tasks/runtime-lifecycle.task.js';

test('设置运行状态页展示已就绪的 Runtime Host 与 OpenClaw，并与公开生命周期事实一致', async ({ actor }) => {
  await actor.attemptsTo(EnterChat());
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      OpenRuntimeLifecycleSettings(),
      Ensure.that(RuntimeHostSettingsStatus(), equals('running')),
      Ensure.that(OpenClawSettingsStatus(), equals('running')),
      ObservePublicRuntimeReadiness(),
      Ensure.that(ElectronStartupOutcome(), equals({ stage: 'ready', outcome: 'started' })),
      Ensure.that(PublicOpenClawReadiness(), equals({
        processState: 'running', gatewayReady: true, portReachable: true, transportState: 'connected', healthSummary: 'healthy',
      })),
      Ensure.that(PublicRuntimeHostReadiness(), equals({ status: 'running', hostLifecycle: 'ready', runtimeLifecycle: 'ready' })),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(EnterChat()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Runtime lifecycle verification failed; cleanup errors retain the original failure');
});
