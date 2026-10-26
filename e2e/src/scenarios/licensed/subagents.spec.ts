import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  BoundedSubagentConfiguration, DeletedSubagentRoute, InvalidSubagentRejection, KnownSubagentTemplateMatches,
  MissingSubagentIdentityMatches, MissingSubagentSupport, NativeSubagentRosterIsReady,
  PublicRosterMatchesSubagentUI, SubagentConfiguration,
} from '../../questions/subagents.question.js';
import { EnterChat } from '../../tasks/chat.task.js';
import {
  CleanUpIndependentSubagent, CreateIndependentSubagent, ProbeDeletedSubagentRoute, ReadKnownSubagentTemplate,
  ReadNativeSubagentsAndInvalidRequest, ReadOpenClawSubagentBoundary, ReloadBoundedSubagentConfiguration,
  RestoreSubagentInheritance, SaveBoundedSubagentConfiguration,
} from '../../tasks/subagents.task.js';

test('Agent 页面与 OpenClaw 公开目录一致，缺失 Agent 的技能读取精确拒绝且脱敏', async ({ actor }) => {
  await actor.attemptsTo(
    EnterChat(), ReadOpenClawSubagentBoundary(),
    Ensure.eventually(PublicRosterMatchesSubagentUI(), equals(true)),
    Ensure.that(MissingSubagentIdentityMatches(), equals(true)),
    Ensure.that(MissingSubagentSupport(), equals({ supportType: 'unsupported', reason: 'agentNotConfigured' })),
  );
});

test('原生 Agent 目录真实可读，畸形管理请求返回精确的公开拒绝', async ({ actor }) => {
  await actor.attemptsTo(
    EnterChat(), ReadNativeSubagentsAndInvalidRequest(),
    Ensure.that(NativeSubagentRosterIsReady(), equals(true)),
    Ensure.that(InvalidSubagentRejection(), equals({ success: false, error: 'Subagent management is unavailable' })),
  );
});

test('已删除的历史 Subagent 路由不可复活且拒绝不泄露内部信息', async ({ actor }) => {
  await actor.attemptsTo(
    EnterChat(), ProbeDeletedSubagentRoute(),
    Ensure.that(DeletedSubagentRoute(), equals({ rejected: true, message: 'Host API request is unavailable.', redacted: true })),
  );
});

test('独立 OpenClaw Agent 的技能与工具配置保存后重载仍一致', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      EnterChat(), ReadKnownSubagentTemplate(),
      Ensure.that(KnownSubagentTemplateMatches(), equals(true)),
      CreateIndependentSubagent(), SaveBoundedSubagentConfiguration(), ReloadBoundedSubagentConfiguration(),
      Ensure.that(SubagentConfiguration(), equals(BoundedSubagentConfiguration())),
      RestoreSubagentInheritance(),
      Ensure.that(SubagentConfiguration(), equals({
        skillMode: 'inheritsDefaultSkills', skillKeys: [], toolMode: 'inheritsDefaultTools', toolPolicy: null, redacted: true,
      })),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(CleanUpIndependentSubagent()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Subagent configuration failed; cleanup errors retain the original failure');
});
