import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { ChatIsVisible } from '../../questions/chat.question.js';
import { DraftDidNotChangeNativeCatalog, ExpectedCatalogReceipt, IndependentCatalogSessionReceipt } from '../../questions/session-catalog.question.js';
import { EnterChat } from '../../tasks/chat.task.js';
import { RecordReadySessionCatalog, SelectCatalogDraft, VerifyIndependentCatalogSession } from '../../tasks/session-catalog.task.js';

test('OpenClaw 新会话草稿不创建原生会话，独立创建后可按完整身份列出和读取且不泄露内部字段', async ({ actor }) => {
  await actor.attemptsTo(
    EnterChat(),
    RecordReadySessionCatalog(),
    SelectCatalogDraft(),
    Ensure.that(ChatIsVisible(), equals(true)),
    Ensure.that(DraftDidNotChangeNativeCatalog(), equals(true)),
    VerifyIndependentCatalogSession(),
    Ensure.that(IndependentCatalogSessionReceipt(), equals(ExpectedCatalogReceipt())),
  );
});
