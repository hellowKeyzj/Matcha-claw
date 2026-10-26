import { Ensure, equals, isGreaterThan } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { EnterChat } from '../../tasks/chat.task.js';
import {
  DraftSecurityPatterns, SecurityDesiredChangeWasRead, SecurityPatternInput, SecurityPolicyHasUnsavedChanges,
  SecurityPolicyIsVisible, SecurityPolicySaveIsEnabled, SecurityPolicySaveSucceeded, SecurityPolicyWasExactlyRestored,
  SecurityRuntimeSaveEffect,
} from '../../questions/security-policy.question.js';
import {
  EditSecurityPolicyWithoutWeakeningProtection, OpenSecurityPolicy, ReopenSavedSecurityPolicy,
  RestoreSecurityPolicy, SaveSecurityPolicyChange,
} from '../../tasks/security-policy.task.js';

test('安全策略真实保存并获运行时确认，刷新可见且精确恢复，不关闭守卫或放宽权限', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      OpenSecurityPolicy(),
      Ensure.that(SecurityPolicyIsVisible(), equals(true)),
      Ensure.that(SecurityPolicySaveIsEnabled(), equals(false)),
      EditSecurityPolicyWithoutWeakeningProtection(),
      Ensure.that(SecurityPolicyHasUnsavedChanges(), equals(true)),
      Ensure.that(SecurityPolicySaveIsEnabled(), equals(true)),
      SaveSecurityPolicyChange(),
      Ensure.that(SecurityPolicySaveSucceeded(), equals(true)),
      Ensure.that(SecurityPolicyHasUnsavedChanges(), equals(false)),
      Ensure.that(SecurityPolicySaveIsEnabled(), equals(false)),
      Ensure.that(SecurityRuntimeSaveEffect().status, equals('succeeded')),
      Ensure.that(SecurityRuntimeSaveEffect().effect, equals('confirmed')),
      Ensure.that(SecurityRuntimeSaveEffect().revision, isGreaterThan(0)),
      Ensure.that(SecurityPatternInput(), equals(DraftSecurityPatterns())),
      ReopenSavedSecurityPolicy(),
      Ensure.that(SecurityDesiredChangeWasRead(), equals(true)),
      Ensure.that(SecurityPolicySaveIsEnabled(), equals(false)),
    );
  } catch (error) { failures.push(error); }
  finally {
    for (const restore of [RestoreSecurityPolicy(), EnterChat()]) {
      try { await actor.attemptsTo(restore); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Security policy failed; cleanup errors retain the original failure');
  await actor.attemptsTo(
    Ensure.that(SecurityPolicyWasExactlyRestored(), equals(true)),
    Ensure.that(SecurityRuntimeSaveEffect().status, equals('succeeded')),
    Ensure.that(SecurityRuntimeSaveEffect().effect, equals('confirmed')),
    Ensure.that(SecurityRuntimeSaveEffect().revision, isGreaterThan(0)),
  );
});
