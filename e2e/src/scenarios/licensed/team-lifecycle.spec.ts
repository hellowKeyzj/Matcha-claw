import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { OwnedTeamLifecycleResult, TrustedTeamSkillReview } from '../../questions/team-lifecycle.question.js';
import {
  CleanupOwnedTeamLifecycle, CreateOwnedTeamThroughUi, DeleteOwnedTeamLifecycle, RestoreTeamLifecycleUi,
  ReviewTrustedTeamSkill, VerifyOwnedTeamCanvas,
} from '../../tasks/team-lifecycle.task.js';

test('公开 Host 选择边界审核可信 TeamSkill 并确认依赖计划', async ({ actor }) => {
  await actor.attemptsTo(
    ReviewTrustedTeamSkill(),
    Ensure.that(TrustedTeamSkillReview(), equals({ selectionSealed: true, packageValid: true, dependenciesReady: true })),
  );
});

test('正常 UI 创建可信 TeamSkill 团队及唯一首 run、呈现真实画布并精确删除自有生命周期', async ({ actor }) => {
  const primaryFailures: unknown[] = [];
  try {
    await actor.attemptsTo(
      CreateOwnedTeamThroughUi(),
      VerifyOwnedTeamCanvas(),
      DeleteOwnedTeamLifecycle(),
      Ensure.that(OwnedTeamLifecycleResult(), equals({
        creationPath: 'ui', materializationAccepted: true, materializationCommitted: true, runCreated: true,
        runtimeConfirmed: true, roleSessionsBound: true, graphProjected: true, startGate: 'intake',
        modelExecution: 'not_requested', businessCompletion: 'not_asserted',
        cancellation: 'not_available_before_start', runPurged: true, teamTombstoned: true, otherTeamsUnchanged: true,
      })),
    );
  } catch (error) {
    primaryFailures.push(error);
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      await actor.attemptsTo(CleanupOwnedTeamLifecycle());
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await actor.attemptsTo(RestoreTeamLifecycleUi());
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length) {
      throw new AggregateError([...primaryFailures, ...cleanupFailures],
        'Owned Team lifecycle requires reconciliation; unknown mutations were not retried and UI restoration was attempted');
    }
  }
});
