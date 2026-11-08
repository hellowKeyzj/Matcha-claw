import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { IabWorkspaceVerified } from '../../questions/iab-workspace.question.js';
import { VerifyIabWorkspace } from '../../tasks/iab-workspace.task.js';

test('IAB工作区 #1 聊天不被关闭后台 native 当前页抢走', async ({ actor }) => {
  await actor.attemptsTo(VerifyIabWorkspace(1), Ensure.that(IabWorkspaceVerified(), equals(1)));
});

test('IAB工作区 #2 主区非浏览器不被后台快照或 native 切页抢走', async ({ actor }) => {
  await actor.attemptsTo(VerifyIabWorkspace(2), Ensure.that(IabWorkspaceVerified(), equals(2)));
});

test('IAB工作区 #3 当前浏览器自动跟随合法 native 切页', async ({ actor }) => {
  await actor.attemptsTo(VerifyIabWorkspace(3), Ensure.that(IabWorkspaceVerified(), equals(3)));
});

test('IAB工作区 #4 新增主区浏览器自动退出非浏览器侧区全屏', async ({ actor }) => {
  await actor.attemptsTo(VerifyIabWorkspace(4), Ensure.that(IabWorkspaceVerified(), equals(4)));
});

test('IAB工作区 #5 新增主区浏览器自动退出看板 UI 的 position full', async ({ actor }) => {
  await actor.attemptsTo(VerifyIabWorkspace(5), Ensure.that(IabWorkspaceVerified(), equals(5)));
});

test('IAB工作区 #6 普通展开侧区新页自动选中且保持布局', async ({ actor }) => {
  await actor.attemptsTo(VerifyIabWorkspace(6), Ensure.that(IabWorkspaceVerified(), equals(6)));
});

test('IAB工作区 #7 收起侧区不被浏览器后台更新展开', async ({ actor }) => {
  await actor.attemptsTo(VerifyIabWorkspace(7), Ensure.that(IabWorkspaceVerified(), equals(7)));
});

test('IAB工作区 #8 隐藏主区普通 native 跟随不退出侧区全屏', async ({ actor }) => {
  await actor.attemptsTo(VerifyIabWorkspace(8), Ensure.that(IabWorkspaceVerified(), equals(8)));
});

test('IAB工作区 #9 双区移动保留页面实例 URL 正文状态且不重载', async ({ actor }) => {
  await actor.attemptsTo(VerifyIabWorkspace(9), Ensure.that(IabWorkspaceVerified(), equals(9)));
});
