import { Task, Wait } from '@serenity-js/core';
import { Click, Enter, isVisible } from '@serenity-js/web';
import { AccountPage } from '../pages/account.page.js';
import { LicensePage } from '../pages/license.page.js';
import { StartAtSignIn } from './account.task.js';

export const EnterLocalFeatures = () => Task.where('#actor enters local features through the real license gate',
  Click.on(AccountPage.continueLocally),
  Wait.until(LicensePage.heading, isVisible()),
  Wait.until(LicensePage.key, isVisible()),
);

export const EnterLicensedSettings = () => Task.where('#actor enters licensed local settings',
  Click.on(AccountPage.continueLocally),
  Click.on(LicensePage.openSettings),
  Wait.until(LicensePage.settings, isVisible()),
  Click.on(LicensePage.license),
  Wait.until(LicensePage.heading, isVisible()),
);

export const OpenGeneralSettings = () => Task.where('#actor opens the unlocked general settings',
  Click.on(LicensePage.general),
  Wait.until(LicensePage.generalHeading, isVisible()),
);

export const ReturnFromSettings = () => Task.where('#actor returns from settings to sign in',
  StartAtSignIn(),
);

export const ShowLicenseKey = () => Task.where('#actor reveals the license input', Click.on(LicensePage.showKey));
export const HideLicenseKey = () => Task.where('#actor conceals the license input', Click.on(LicensePage.hideKey));

export const SubmitMalformedLicense = () => Task.where('#actor submits a malformed license through the real validation form',
  Enter.theValue('not-a-license').into(LicensePage.key),
  Click.on(LicensePage.activate),
  Wait.until(LicensePage.error, isVisible()),
);

export const LeaveLicenseSettings = () => Task.where('#actor clears their input and returns to sign in',
  Enter.theValue('').into(LicensePage.key),
  StartAtSignIn(),
);
