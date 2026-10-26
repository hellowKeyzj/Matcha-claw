import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { equals } from '@serenity-js/assertions';
import { Click, Enter, isVisible } from '@serenity-js/web';
import { AccountPage } from '../pages/account.page.js';
import { ChatPage } from '../pages/chat.page.js';
import { AccountEntryIsVisible } from '../questions/account.question.js';

export const StartAtSignIn = () => Task.where('#actor returns to the sign-in screen without resetting shared data',
  Wait.upTo(Duration.ofSeconds(45)).until(AccountEntryIsVisible(), equals(true)),
  Check.whether(AccountPage.registerHeading, isVisible()).andIfSo(ReturnToSignIn()),
  Check.whether(AccountPage.signInHeading, isVisible()).andIfSo().otherwise(
    Check.whether(ChatPage.switchboard, isVisible()).andIfSo(Click.on(ChatPage.switchboardBackdrop)),
    Check.whether(ChatPage.fullscreenPanel, isVisible()).andIfSo(Click.on(ChatPage.closeSidePanel)),
    Check.whether(AccountPage.expandSidebar, isVisible()).andIfSo(Click.on(AccountPage.expandSidebar)),
    Click.on(AccountPage.accountMenu),
    Click.on(AccountPage.signInMenuItem),
  ),
  Wait.upTo(Duration.ofSeconds(45)).until(AccountPage.signInHeading, isVisible()),
  Enter.theValue('').into(AccountPage.email),
  Enter.theValue('').into(AccountPage.password),
);

export const OpenRegistration = () => Task.where('#actor opens account registration',
  Click.on(AccountPage.registerLink),
  Wait.until(AccountPage.registerHeading, isVisible()),
);

export const ReturnToSignIn = () => Task.where('#actor returns from registration to sign in',
  Click.on(AccountPage.signInLink),
  Wait.until(AccountPage.signInHeading, isVisible()),
);
