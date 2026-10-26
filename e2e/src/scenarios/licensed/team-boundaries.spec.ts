import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  ElectronTeamBoundaryReceipt, InvalidTeamSkillAlert, InvalidTeamSkillCreateIsEnabled, InvalidTeamSkillReceipt,
  OriginalTeamsAreUnchanged, RustTeamBoundaryReceipt,
} from '../../questions/team-boundaries.question.js';
import { EnterChat } from '../../tasks/chat.task.js';
import {
  CancelInvalidTeamSkillReview, CheckElectronTeamBoundary, CheckInvalidTeamSkillPackage, CheckRustTeamBoundary,
  CleanupInvalidTeamSkillPackage, RestoreTeamBoundaryDialog, ReviewInvalidTeamSkillThroughUI,
} from '../../tasks/team-boundaries.task.js';

test('非法 TeamSkill 经 Renderer、Electron、Rust 返回封闭 invalid 且不泄露路径或正文', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      EnterChat(),
      CheckInvalidTeamSkillPackage(),
      Ensure.that(InvalidTeamSkillReceipt(), equals({
        ipcOk: true, status: 200, httpOk: true, exactBody: true,
        privatePathExposed: false, privateContentExposed: false,
      })),
      ReviewInvalidTeamSkillThroughUI(),
      Ensure.that(InvalidTeamSkillAlert(), equals('TeamSkill 包无效')),
      Ensure.that(InvalidTeamSkillCreateIsEnabled(), equals(false)),
      CancelInvalidTeamSkillReview(),
      Ensure.that(OriginalTeamsAreUnchanged(), equals(true)),
    );
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await actor.attemptsTo(RestoreTeamBoundaryDialog());
    } catch (error) {
      failures.push(error);
    }
    try {
      await actor.attemptsTo(CleanupInvalidTeamSkillPackage());
    } catch (error) {
      failures.push(error);
    }
    try {
      await actor.attemptsTo(EnterChat());
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Invalid TeamSkill validation or owned UI/package cleanup failed');
});

test('Electron 拒绝不匹配的 TeamSkill 目标且只返回固定公开错误', async ({ actor }) => {
  await actor.attemptsTo(
    EnterChat(),
    CheckElectronTeamBoundary(),
    Ensure.that(ElectronTeamBoundaryReceipt(), equals({
      ipcOk: true, status: 400, httpOk: false, exactBody: true,
      privatePathExposed: false, privateContentExposed: false,
    })),
  );
});

test('Rust 拒绝 TeamSkill 额外私有字段且只返回固定公开错误', async ({ actor }) => {
  await actor.attemptsTo(
    EnterChat(),
    CheckRustTeamBoundary(),
    Ensure.that(RustTeamBoundaryReceipt(), equals({
      ipcOk: true, status: 400, httpOk: false, exactBody: true,
      privatePathExposed: false, privateContentExposed: false,
    })),
  );
});
