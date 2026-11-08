import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { IabWorkspaceRaceVerified } from '../../questions/iab-workspace-races.question.js';
import { VerifyIabWorkspaceRace } from '../../tasks/iab-workspace-races.task.js';

for (const iteration of [1, 2, 3, 4, 5]) {
  test(`IAB工作区 #10-${iteration} 原draft开页真实响应未交付时Session先创建`, async ({ actor }) => {
    await actor.attemptsTo(VerifyIabWorkspaceRace(10, iteration), Ensure.that(IabWorkspaceRaceVerified(), equals(`10:${iteration}`)));
  });

  test(`IAB工作区 #11-${iteration} 开页完整完成后Session再创建`, async ({ actor }) => {
    await actor.attemptsTo(VerifyIabWorkspaceRace(11, iteration), Ensure.that(IabWorkspaceRaceVerified(), equals(`11:${iteration}`)));
  });

  test(`IAB工作区 #12-${iteration} A在途切B后A迟到不抢占B`, async ({ actor }) => {
    await actor.attemptsTo(VerifyIabWorkspaceRace(12, iteration), Ensure.that(IabWorkspaceRaceVerified(), equals(`12:${iteration}`)));
  });
}
