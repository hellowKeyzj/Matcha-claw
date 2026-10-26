import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../fixtures/serenity.js';
import { SignInIsVisible } from '../questions/account.question.js';
import { GeneralSettingsIsEnabled, LicenseErrorIsInvalidFormat, LicenseInputType, LicenseIsBlocked } from '../questions/license.question.js';
import { StartAtSignIn } from '../tasks/account.task.js';
import { EnterLocalFeatures, HideLicenseKey, LeaveLicenseSettings, ShowLicenseKey, SubmitMalformedLicense } from '../tasks/license.task.js';

test('本地进入要求真实授权，格式错误的授权码不会解锁设置', async ({ actor }) => {
  await actor.attemptsTo(
    StartAtSignIn(),
    EnterLocalFeatures(),
    Ensure.that(LicenseIsBlocked(), equals(true)),
    Ensure.that(GeneralSettingsIsEnabled(), equals(false)),
    Ensure.that(LicenseInputType(), equals('password')),
    ShowLicenseKey(),
    Ensure.that(LicenseInputType(), equals('text')),
    HideLicenseKey(),
    Ensure.that(LicenseInputType(), equals('password')),
    SubmitMalformedLicense(),
    Ensure.eventually(LicenseErrorIsInvalidFormat(), equals(true)),
    Ensure.that(LicenseIsBlocked(), equals(true)),
    Ensure.that(GeneralSettingsIsEnabled(), equals(false)),
    LeaveLicenseSettings(),
    Ensure.that(SignInIsVisible(), equals(true)),
  );
});
