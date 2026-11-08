import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { AgentBrowserWasVerified } from '../../questions/iab-agent.question.js';
import { VerifyAgentBrowser } from '../../tasks/iab-agent.task.js';

test('简单 Agent 浏览器任务：读取随机验证码并填写确认', async ({ actor }) => {
  await actor.attemptsTo(VerifyAgentBrowser('simple'), Ensure.that(AgentBrowserWasVerified(), equals(true)));
});

test('复杂 Agent 浏览器任务：表单、存储、刷新、历史导航、滚动及截图', async ({ actor }) => {
  await actor.attemptsTo(VerifyAgentBrowser('complex'), Ensure.that(AgentBrowserWasVerified(), equals(true)));
});

test('两个独立会话的真实 Agent 并发操作各自页面，单方结束不影响另一方', async ({ actor }) => {
  await actor.attemptsTo(VerifyAgentBrowser('parallel'), Ensure.that(AgentBrowserWasVerified(), equals(true)));
});

test('同根任务两个原生子 Agent 各自操作网页，叶子结束保留页面、根结束清理', async ({ actor }) => {
  await actor.attemptsTo(VerifyAgentBrowser('subagents'), Ensure.that(AgentBrowserWasVerified(), equals(true)));
});
