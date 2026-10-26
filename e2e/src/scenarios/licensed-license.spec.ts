import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../fixtures/serenity.js';
import { SignInIsVisible } from '../questions/account.question.js';
import { GeneralSettingsIsEnabled, GeneralSettingsIsVisible, LicenseIsGranted } from '../questions/license.question.js';
import { StartAtSignIn } from '../tasks/account.task.js';
import { EnterLicensedSettings, OpenGeneralSettings, ReturnFromSettings } from '../tasks/license.task.js';

test('专用 Profile 保留真实授权，本地进入后可打开通用设置', async ({ actor }) => {
  await actor.attemptsTo(
    StartAtSignIn(),
    EnterLicensedSettings(),
    Ensure.eventually(LicenseIsGranted(), equals(true)),
    Ensure.that(GeneralSettingsIsEnabled(), equals(true)),
    OpenGeneralSettings(),
    Ensure.that(GeneralSettingsIsVisible(), equals(true)),
    ReturnFromSettings(),
    Ensure.that(SignInIsVisible(), equals(true)),
  );
});
