import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { AgentBrowserWasVerified } from '../../questions/iab-agent.question.js';
import { VerifyAgentBrowser } from '../../tasks/iab-agent.task.js';

test('真实默认 Agent 经插件读取网页、输入点击、切换标签与截图', async ({ actor }) => {
  await actor.attemptsTo(
    VerifyAgentBrowser(),
    Ensure.that(AgentBrowserWasVerified(), equals(true)),
  );
});
