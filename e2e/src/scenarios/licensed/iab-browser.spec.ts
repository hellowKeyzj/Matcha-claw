import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { EmbeddedBrowserSummary } from '../../questions/iab-browser.question.js';
import { VerifyEmbeddedBrowser } from '../../tasks/iab-browser.task.js';

test('内置浏览器完整功能验收，仅使用专用 Profile 并最后清除网站数据', async ({ actor }) => {
  await actor.attemptsTo(
    VerifyEmbeddedBrowser(),
    Ensure.that(EmbeddedBrowserSummary(), equals({ passed: 15, failed: 0 })),
  );
});
