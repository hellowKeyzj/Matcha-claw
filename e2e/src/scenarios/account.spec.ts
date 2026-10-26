import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../fixtures/serenity.js';
import { RegistrationIsEnabled, RegistrationIsVisible, SignInIsEnabled, SignInIsVisible } from '../questions/account.question.js';
import { OpenRegistration, ReturnToSignIn, StartAtSignIn } from '../tasks/account.task.js';

test('用户可在登录和注册间往返，空表单不能提交', async ({ actor }) => {
  await actor.attemptsTo(
    StartAtSignIn(),
    Ensure.that(SignInIsVisible(), equals(true)),
    Ensure.that(SignInIsEnabled(), equals(false)),
    OpenRegistration(),
    Ensure.that(RegistrationIsVisible(), equals(true)),
    Ensure.that(RegistrationIsEnabled(), equals(false)),
    ReturnToSignIn(),
    Ensure.that(SignInIsVisible(), equals(true)),
  );
});
