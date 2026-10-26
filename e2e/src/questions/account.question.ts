import { Question } from '@serenity-js/core';
import { AccountPage } from '../pages/account.page.js';

export const AccountEntryIsVisible = () => Question.about('account screen or local navigation is visible', async actor =>
  await actor.answer(AccountPage.signInHeading.isVisible())
  || await actor.answer(AccountPage.registerHeading.isVisible())
  || await actor.answer(AccountPage.accountMenu.isVisible())
  || await actor.answer(AccountPage.expandSidebar.isVisible())
  || await actor.answer(AccountPage.collapseSidebar.isVisible()),
);

export const SignInIsVisible = () => AccountPage.signInHeading.isVisible().describedAs('sign-in form is visible');
export const RegistrationIsVisible = () => AccountPage.registerHeading.isVisible().describedAs('registration form is visible');
export const RegistrationIsEnabled = () => AccountPage.registerSubmit.isEnabled().describedAs('registration submission is enabled');
export const SignInIsEnabled = () => AccountPage.signInSubmit.isEnabled().describedAs('sign-in submission is enabled');
