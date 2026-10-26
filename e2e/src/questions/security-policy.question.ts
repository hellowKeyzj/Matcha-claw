import { notes } from '@serenity-js/core';
import { Attribute, Value } from '@serenity-js/web';
import { SecurityPolicyPage } from '../pages/security-policy.page.js';

type SecurityPolicyNotes = {
  securityOriginalPatterns: string;
  securityDraftPatterns: string;
  securityCleanup: 'none' | 'discard' | 'restore';
  securityPolicyRestored: boolean;
  securityDesiredChange: boolean;
  securitySaveEffect: { status: string; effect: string; revision: number };
};

export const SecurityPolicyIsVisible = () => SecurityPolicyPage.heading.isVisible();
export const SecurityPolicySaveIsEnabled = () => SecurityPolicyPage.save.isEnabled();
export const SecurityPolicyHasUnsavedChanges = () => SecurityPolicyPage.unsaved.isVisible();
export const SecurityPolicySaveSucceeded = () => SecurityPolicyPage.saved.isVisible();
export const SecurityRuntimeGuardState = () => Attribute.called('aria-checked').of(SecurityPolicyPage.guard);
export const SecurityInjectionGuardState = () => Attribute.called('aria-checked').of(SecurityPolicyPage.injectionGuard);
export const SecurityPatternInput = () => Value.of(SecurityPolicyPage.patterns);
export const OriginalSecurityPatterns = () => notes<SecurityPolicyNotes>().get('securityOriginalPatterns');
export const DraftSecurityPatterns = () => notes<SecurityPolicyNotes>().get('securityDraftPatterns');
export const SecurityCleanupAction = () => notes<SecurityPolicyNotes>().get('securityCleanup');
export const SecurityDesiredChangeWasRead = () => notes<SecurityPolicyNotes>().get('securityDesiredChange');
export const SecurityRuntimeSaveEffect = () => notes<SecurityPolicyNotes>().get('securitySaveEffect');
export const SecurityPolicyWasExactlyRestored = () => notes<SecurityPolicyNotes>().get('securityPolicyRestored');
