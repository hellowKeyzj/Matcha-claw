import { Ensure, equals, includes, matches } from '@serenity-js/assertions';
import { Duration } from '@serenity-js/core';
import { test } from '../../fixtures/serenity.js';
import {
  MatchaHistoryAssistantText, MatchaHistoryCleanupState, MatchaHistoryMarkdownWasVerified, MatchaHistoryMarker, MatchaHistoryPrompt,
  MatchaHistoryRecoveredAfterNativeRestart, MatchaHistoryRuntimeIsReady, MatchaHistorySessionKey,
  MatchaHistorySessionWasCreated, MatchaHistoryTurnCompleted, MatchaHistoryUserText, MatchaPublicHistoryWasVerified,
} from '../../questions/matcha-history.question.js';
import {
  CleanUpMatchaHistory, CreatePublicMatchaHistory, ExportMatchaHistory, OpenMatchaHistory, PrepareMatchaHistory,
  ReadMatchaHistory, RecoverMatchaHistory, RunMatchaHistoryTurn, StartMatchaHistoryDraft,
} from '../../tasks/matcha-history.task.js';

test('Matcha 公开创建合同返回完整脱敏 identity，精确删除后目录不再包含该会话', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      PrepareMatchaHistory(),
      Ensure.that(MatchaHistoryRuntimeIsReady(), equals(true)),
      CreatePublicMatchaHistory(),
      Ensure.that(MatchaHistorySessionWasCreated(), equals(true)),
      Ensure.that(MatchaHistorySessionKey(), matches(/^matcha-agent:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)),
    );
  } catch (error) { failures.push(error); }
  finally {
    try {
      await actor.attemptsTo(CleanUpMatchaHistory(), Ensure.that(MatchaHistoryCleanupState(), equals('deleted')));
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Public Matcha creation failed; exact cleanup errors retain the original failure');
});

test('Chat 中新建 Matcha 草稿、唯一发送并导出真实历史，原生 app-server 重启后恢复同一会话', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      PrepareMatchaHistory(),
      Ensure.that(MatchaHistoryRuntimeIsReady(), equals(true)),
      StartMatchaHistoryDraft(),
      RunMatchaHistoryTurn(),
      Ensure.that(MatchaHistorySessionWasCreated(), equals(true)),
      Ensure.that(MatchaHistorySessionKey(), matches(/^matcha-agent:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)),
      Ensure.that(MatchaHistoryTurnCompleted(), equals(true)),
      ReadMatchaHistory(),
      Ensure.that(MatchaPublicHistoryWasVerified(), equals(true)),
      OpenMatchaHistory(),
      Ensure.eventually(MatchaHistoryUserText(), equals(MatchaHistoryPrompt())).timeoutAfter(Duration.ofSeconds(15)),
      Ensure.eventually(MatchaHistoryAssistantText(), includes(MatchaHistoryMarker())).timeoutAfter(Duration.ofSeconds(15)),
      ExportMatchaHistory(),
      Ensure.that(MatchaHistoryMarkdownWasVerified(), equals(true)),
      RecoverMatchaHistory(),
      Ensure.that(MatchaHistoryRecoveredAfterNativeRestart(), equals(true)),
    );
  } catch (error) { failures.push(error); }
  finally {
    try {
      await actor.attemptsTo(CleanUpMatchaHistory(), Ensure.that(MatchaHistoryCleanupState(), equals('deleted')));
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Matcha UI history failed; restoration and exact cleanup errors retain the original failure');
});
