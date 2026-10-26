import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { DashboardUsageMatchesPublicProjection } from '../../questions/usage-history.question.js';
import { OpenDashboardUsage } from '../../tasks/usage-history.task.js';
import { EnterChat } from '../../tasks/chat.task.js';

test('Dashboard 按当前 Runtime 的公开用量投影展示真实历史或合法空态，不把失败当空数据', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      OpenDashboardUsage(),
      Ensure.eventually(DashboardUsageMatchesPublicProjection(), equals(true)),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(EnterChat()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Usage history verification failed; cleanup errors retain the original failure');
});
