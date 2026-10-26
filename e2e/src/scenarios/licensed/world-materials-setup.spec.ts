import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorldMaterialsSetupEvidence } from '../../questions/world-materials-setup.question.js';
import { PrepareSignedWorldMaterials, PreserveSignedWorldMaterials } from '../../tasks/world-materials-setup.task.js';

test('World materials 签名包：正常 UI 精确信任、安装并确认启用，保留原回执且不授权、不激活、不发布', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      PrepareSignedWorldMaterials(),
      Ensure.that(WorldMaterialsSetupEvidence().phase, equals('enabled')),
      Ensure.that(WorldMaterialsSetupEvidence().enabled, equals(true)),
      Ensure.that(WorldMaterialsSetupEvidence().signatureVerified, equals(true)),
      Ensure.that(WorldMaterialsSetupEvidence().rootFlagsFalse, equals(true)),
    );
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await actor.attemptsTo(PreserveSignedWorldMaterials()); }
    catch (cleanupFailure) { throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure], 'Original signed materials failure, cleanup failures and durable history retained'); }
  }
});
