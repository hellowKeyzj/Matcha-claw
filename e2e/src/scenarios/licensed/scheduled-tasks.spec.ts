import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  ScheduledTaskDeletionWasConfirmed, ScheduledTaskEntry, ScheduledTaskExecution,
  ScheduledTaskReadbackMatches, ScheduledTaskTriggerRejection,
} from '../../questions/scheduled-tasks.question.js';
import { EnterChat } from '../../tasks/chat.task.js';
import {
  CleanupScheduledTask, CreateIndependentScheduledTask, DeleteOwnedScheduledTask, DismissOwnedScheduledTaskDialog,
  EditOwnedScheduledTask, RefreshOwnedScheduledTask, RejectPrivateMalformedScheduledTaskTrigger,
  RestoreScheduledTaskRuntime, SetOwnedScheduledTaskEnabled, TriggerOwnedScheduledTask, VisitScheduledTaskEntry,
} from '../../tasks/scheduled-tasks.task.js';

test('任务中心定时任务入口可用，旧 Cron 地址重定向到同一 scheduled tab', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      VisitScheduledTaskEntry(),
      Ensure.that(ScheduledTaskEntry(), equals({
        entryRoute: '#/tasks?tab=scheduled', entryVisible: true, legacyRoute: '#/tasks?tab=scheduled',
        scheduledTabSelected: true, legacyConsumerVisible: true,
      })),
    );
  } catch (error) { failures.push(error); }
  finally {
    for (const restore of [RestoreScheduledTaskRuntime(), EnterChat()]) {
      try { await actor.attemptsTo(restore); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Scheduled-task entry failed; restoration errors retain the original failure');
});

test('独占遥远定时任务经当前 UI 创建、刷新、暂停恢复、编辑和精确删除，公开快照一致', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      CreateIndependentScheduledTask(), RefreshOwnedScheduledTask(),
      SetOwnedScheduledTaskEnabled(false), SetOwnedScheduledTaskEnabled(true), SetOwnedScheduledTaskEnabled(false),
      EditOwnedScheduledTask(), Ensure.that(ScheduledTaskReadbackMatches(), equals(true)),
      DeleteOwnedScheduledTask(), Ensure.that(ScheduledTaskDeletionWasConfirmed(), equals(true)),
    );
  } catch (error) { failures.push(error); }
  finally {
    for (const restore of [DismissOwnedScheduledTaskDialog(), CleanupScheduledTask(), RestoreScheduledTaskRuntime(), EnterChat()]) {
      try { await actor.attemptsTo(restore); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Scheduled-task CRUD failed; cleanup errors retain the original failure');
});

test('畸形定时任务触发请求返回固定拒绝且不反射私有输入', async ({ actor }) => {
  await actor.attemptsTo(
    RejectPrivateMalformedScheduledTaskTrigger(),
    Ensure.that(ScheduledTaskTriggerRejection(), equals({
      transportOk: true, status: 400, httpOk: false,
      fixedRejection: true, privateInputReflected: false, privateFieldExposed: false,
    })),
  );
});

test('真实定时任务手动触发并验证同 call/job 的原生终态（须先获批安全执行前提）', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      CreateIndependentScheduledTask('trigger'), SetOwnedScheduledTaskEnabled(false), EditOwnedScheduledTask('trigger'),
      TriggerOwnedScheduledTask(),
      Ensure.that(ScheduledTaskExecution(), equals({
        admitted: true, sameCallSettled: true, sameJobNativeSucceeded: true, hasRunId: true,
      })),
      DeleteOwnedScheduledTask(), Ensure.that(ScheduledTaskDeletionWasConfirmed(), equals(true)),
    );
  } catch (error) { failures.push(error); }
  finally {
    for (const restore of [DismissOwnedScheduledTaskDialog(), CleanupScheduledTask(), RestoreScheduledTaskRuntime(), EnterChat()]) {
      try { await actor.attemptsTo(restore); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Real Cron execution failed; cleanup errors retain the original failure');
});
