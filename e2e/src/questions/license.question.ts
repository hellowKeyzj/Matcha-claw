import { Question } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { LicensePage } from '../pages/license.page.js';

export const LicenseIsGranted = () => Question.about('license is granted', async actor =>
  /^(Granted|已授权)$/.test(await actor.answer(Text.of(LicensePage.status))));
export const GeneralSettingsIsVisible = () => LicensePage.generalHeading.isVisible().describedAs('general settings content is visible');
export const LicenseIsBlocked = () => Question.about('license is blocked', async actor =>
  /^(Blocked|未授权)$/.test(await actor.answer(Text.of(LicensePage.status))));
export const LicenseErrorIsInvalidFormat = () => Question.about('license error rejects the invalid key format', async actor =>
  /^(Invalid license key format|授权码格式有误)$/.test(await actor.answer(Text.of(LicensePage.error))));
export const LicenseInputType = () => Attribute.called('type').of(LicensePage.key);
export const GeneralSettingsIsEnabled = () => LicensePage.general.isEnabled().describedAs('general settings navigation is enabled');
