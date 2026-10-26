import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { MalformedSessionCatalogRejection } from '../../questions/session-boundaries.question.js';
import { SubmitMalformedSessionCatalog } from '../../tasks/session-boundaries.task.js';

test('公开会话目录拒绝额外私有字段且不回显输入', async ({ actor }) => {
  await actor.attemptsTo(
    SubmitMalformedSessionCatalog(),
    Ensure.that(MalformedSessionCatalogRejection(), equals({
      ipcOk: true,
      status: 500,
      httpOk: false,
      body: { success: false, error: 'Capability request failed' },
      reflectsInput: false,
    })),
  );
});
