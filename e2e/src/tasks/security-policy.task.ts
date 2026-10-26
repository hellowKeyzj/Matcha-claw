import { equals } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Click, Enter, isEnabled, isVisible, Navigate } from '@serenity-js/web';
import {
  BorrowSecurityPolicy, ConfirmSecuritySave, NavigateToSecurityPolicy, ObserveSecurityDesiredChange, ObserveSecurityRestoration,
  PlanSecurityCleanup, PrepareSecuritySave, RememberPublicSecurityPolicy,
} from '../interactions/security-policy.interaction.js';
import { SecurityPolicyPage } from '../pages/security-policy.page.js';
import {
  DraftSecurityPatterns, OriginalSecurityPatterns, SecurityCleanupAction,
  SecurityInjectionGuardState, SecurityPatternInput, SecurityPolicySaveIsEnabled, SecurityPolicySaveSucceeded, SecurityRuntimeGuardState,
} from '../questions/security-policy.question.js';
import { EnterChat } from './chat.task.js';

const ShowRuntimeSecurity = () => Task.where('#actor displays current runtime security controls',
  Wait.until(SecurityPolicyPage.heading, isVisible()),
  Click.on(SecurityPolicyPage.runtimeSection),
  Wait.until(SecurityPolicyPage.guard, isEnabled()),
  Wait.until(SecurityRuntimeGuardState(), equals('true')),
  Wait.until(SecurityInjectionGuardState(), equals('true')),
);

const ShowSecurityPatterns = () => Task.where('#actor displays prompt injection patterns',
  Click.on(SecurityPolicyPage.guardsSection),
  Wait.until(SecurityPolicyPage.patterns, isEnabled()),
);

const SaveSecurityPolicy = (purpose: 'change' | 'restore') => Task.where(`#actor saves security policy ${purpose} once through the real UI`,
  Wait.until(SecurityPolicySaveSucceeded(), equals(false)),
  Wait.until(SecurityPolicySaveIsEnabled(), equals(true)),
  PrepareSecuritySave(purpose),
  Click.on(SecurityPolicyPage.save),
  ConfirmSecuritySave(),
  Wait.upTo(Duration.ofSeconds(10)).until(SecurityPolicySaveSucceeded(), equals(true)),
  Wait.until(SecurityPolicySaveIsEnabled(), equals(false)),
);

export const OpenSecurityPolicy = () => Task.where('#actor opens the existing desktop security policy UI',
  BorrowSecurityPolicy(),
  EnterChat(),
  NavigateToSecurityPolicy(),
  ShowRuntimeSecurity(),
  RememberPublicSecurityPolicy(),
  ShowSecurityPatterns(),
  Wait.until(SecurityPatternInput(), equals(OriginalSecurityPatterns())),
);

export const EditSecurityPolicyWithoutWeakeningProtection = () => Task.where('#actor adds a never-matching detection pattern without changing permissions or guards',
  Enter.theValue(DraftSecurityPatterns()).into(SecurityPolicyPage.patterns),
  Wait.until(SecurityPatternInput(), equals(DraftSecurityPatterns())),
);

export const SaveSecurityPolicyChange = () => SaveSecurityPolicy('change');

export const ReopenSavedSecurityPolicy = () => Task.where('#actor reloads the saved security policy and reads its public desired DTO',
  Navigate.reloadPage(),
  ShowRuntimeSecurity(),
  ShowSecurityPatterns(),
  Wait.until(SecurityPatternInput(), equals(DraftSecurityPatterns())),
  ObserveSecurityDesiredChange(),
);

export const RestoreSecurityPolicy = () => Task.where('#actor restores only its confirmed security change, never an unknown effect',
  PlanSecurityCleanup(),
  Check.whether(SecurityCleanupAction(), equals('none')).andIfSo().otherwise(
    Navigate.reloadPage(),
    ShowRuntimeSecurity(),
    ShowSecurityPatterns(),
    Check.whether(SecurityCleanupAction(), equals('restore')).andIfSo(
      Enter.theValue(OriginalSecurityPatterns()).into(SecurityPolicyPage.patterns),
      SaveSecurityPolicy('restore'),
      Navigate.reloadPage(),
      ShowRuntimeSecurity(),
      ShowSecurityPatterns(),
    ),
    Wait.until(SecurityPatternInput(), equals(OriginalSecurityPatterns())),
    Wait.until(SecurityPolicySaveIsEnabled(), equals(false)),
    ObserveSecurityRestoration(),
  ),
);
