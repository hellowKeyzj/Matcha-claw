import { Ensure, equals, includes, not } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { ChatBodyText } from '../../questions/chat.question.js';
import {
  InvalidLifecycleUpdateWasRejected, InvalidTaskRejections, LifecycleCompletionWasApplied, LifecycleDeletionWasConfirmed,
  LifecyclePrivateMarker, LifecycleUpdateExposedPrivateData, OwnedLifecycleTask, OwnedTaskTitleIsVisible,
  TaskCenterErrorCount, TaskCenterOwnedDetail, TaskCenterOwnedId, TaskCenterOwnedStatus, TaskRequestExposedPrivateData,
} from '../../questions/tasks-lifecycle.question.js';
import { EnterChat, StartOpenClawDraft } from '../../tasks/chat.task.js';
import {
  CheckInvalidLifecycleUpdate, CheckInvalidTaskPrivacy, CleanupTaskLifecycle, CompleteLifecycleTask, CreateLifecycleTask,
  DeleteLifecycleTaskThroughUi, OpenOwnedTaskDetail, OpenTaskCenterDirectory, PrepareTaskLifecycle, RestoreLifecycleRuntime,
} from '../../tasks/tasks-lifecycle.task.js';

test('非法 TaskCreate 与未知操作返回封闭错误，Task Center 和 Chat 不泄露私有输入', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      EnterChat(), StartOpenClawDraft(), PrepareTaskLifecycle(), CheckInvalidTaskPrivacy(),
      Ensure.that(InvalidTaskRejections(), equals([true, true])),
      Ensure.that(TaskRequestExposedPrivateData(), equals(false)),
      OpenTaskCenterDirectory(),
      Ensure.that(ChatBodyText(), not(includes(LifecyclePrivateMarker()))),
      Ensure.that(ChatBodyText(), not(includes('workspaceDir'))),
      EnterChat(),
      Ensure.that(ChatBodyText(), not(includes(LifecyclePrivateMarker()))),
      Ensure.that(ChatBodyText(), not(includes('workspaceDir'))),
    );
  } catch (error) { failures.push(error); }
  finally {
    for (const restore of [RestoreLifecycleRuntime(), EnterChat()]) {
      try { await actor.attemptsTo(restore); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Task privacy failed; restoration errors retain the original failure');
});

test('public OpenClaw TaskCreate → Task Center 投影，完成后跨页重读并经 UI 精确删除', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      EnterChat(), StartOpenClawDraft(), PrepareTaskLifecycle(), CreateLifecycleTask(),
      Ensure.that(OwnedLifecycleTask().status, equals('pending')),
      OpenTaskCenterDirectory(), OpenOwnedTaskDetail(),
      Ensure.that(TaskCenterErrorCount(), equals(0)),
      Ensure.that(TaskCenterOwnedId(), equals(OwnedLifecycleTask().id)),
      Ensure.that(TaskCenterOwnedStatus(), equals('pending')),
      Ensure.that(TaskCenterOwnedDetail(), includes(OwnedLifecycleTask().description)),
      EnterChat(), CompleteLifecycleTask(),
      Ensure.that(LifecycleCompletionWasApplied(), equals(true)),
      OpenTaskCenterDirectory(), OpenOwnedTaskDetail(),
      Ensure.that(TaskCenterErrorCount(), equals(0)),
      Ensure.that(TaskCenterOwnedId(), equals(OwnedLifecycleTask().id)),
      Ensure.that(TaskCenterOwnedStatus(), equals('completed')),
      Ensure.that(TaskCenterOwnedDetail(), includes(OwnedLifecycleTask().description)),
      CheckInvalidLifecycleUpdate(),
      Ensure.that(InvalidLifecycleUpdateWasRejected(), equals(true)),
      Ensure.that(LifecycleUpdateExposedPrivateData(), equals(false)),
      Ensure.that(ChatBodyText(), not(includes(LifecyclePrivateMarker()))),
      Ensure.that(ChatBodyText(), not(includes('workspaceDir'))),
      DeleteLifecycleTaskThroughUi(), Ensure.that(LifecycleDeletionWasConfirmed(), equals(true)),
      Ensure.eventually(OwnedTaskTitleIsVisible(), equals(false)),
    );
  } catch (error) { failures.push(error); }
  finally {
    for (const restore of [CleanupTaskLifecycle(), RestoreLifecycleRuntime(), EnterChat()]) {
      try { await actor.attemptsTo(restore); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Task lifecycle failed; cleanup errors retain the original failure');
});
