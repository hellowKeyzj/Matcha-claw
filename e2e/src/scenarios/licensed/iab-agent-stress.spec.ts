import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { AgentBrowserWasVerified } from '../../questions/iab-agent.question.js';
import { VerifyAgentBrowser } from '../../tasks/iab-agent.task.js';

test('极端多 Agent 浏览器验收：不同 Agent 独立会话、子 Agent 并发、争用、取消、接续和导航关闭', async ({ actor }) => {
  await actor.attemptsTo(VerifyAgentBrowser('stress'), Ensure.that(AgentBrowserWasVerified(), equals(true)));
});
