import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { WorkspaceObjectsDecodeFailures, WorkspaceOriginal, WorkspaceUnchanged } from '../../questions/world-workspace.question.js';
import {
  InspectOriginalWorldTask, InspectWorldDirectories, InspectWorldObjectsDecodeFailures, InspectWorldOperations, InspectWorldWriteGates, InspectWorldNavigation,
  LeaveWorldWorkspace, OpenWorldWorkspace,
} from '../../tasks/world-workspace.task.js';

test('World 四页 ready 与六目录完整刷新：五轮真实并发公开查询不误拒，不以首批空数组冒充完整结果', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(OpenWorldWorkspace(), InspectWorldDirectories(),
      Ensure.that(WorkspaceOriginal().exact, equals(true)),
      Ensure.that(WorkspaceUnchanged(), equals({ task: true, noOp: true, activeRelease: true })));
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'World directory inspection and UI restoration failed; all failures retained');
});

test('World Tasks 管理读取原完整零效果契约，按真实独立评测前提核对组合视图且不登记或执行', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(OpenWorldWorkspace(), InspectOriginalWorldTask(),
      Ensure.that(WorkspaceOriginal().exact, equals(true)),
      Ensure.that(WorkspaceUnchanged(), equals({ task: true, noOp: true, activeRelease: true })));
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'World Task inspection and UI restoration failed; all failures retained');
});

test('World Operations 仅核真实会话记录的公开回执，无记录不冒称全历史为空，随机无效编号明确 not-found', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(OpenWorldWorkspace(), InspectWorldOperations(),
      Ensure.that(WorkspaceOriginal().exact, equals(true)),
      Ensure.that(WorkspaceUnchanged(), equals({ task: true, noOp: true, activeRelease: true })));
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'World operation inspection and UI restoration failed; all failures retained');
});

test('World 空白编号、未选资料策略与无建模依据均禁写，原 Task、完整 NoOp 与活跃发布保持不变', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(OpenWorldWorkspace(), InspectWorldWriteGates(),
      Ensure.that(WorkspaceOriginal().exact, equals(true)),
      Ensure.that(WorkspaceUnchanged(), equals({ task: true, noOp: true, activeRelease: true })));
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'World write-gate inspection and UI restoration failed; all failures retained');
});

test('World 公开 objects 八类输入在 Decode 精确拒绝且安全诊断，随后合法目录读取恢复，原 Task、NoOp 与活跃发布不变', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(OpenWorldWorkspace(), InspectWorldObjectsDecodeFailures(),
      Ensure.that(WorkspaceObjectsDecodeFailures(), equals({ cases: [
        'zero page limit', 'empty Union', 'empty Aggregate', 'empty Project', 'duplicate parameter',
        'missing required argument', 'unexpected argument', 'duplicate argument',
      ], publicOnly: true })),
      Ensure.that(WorkspaceOriginal().exact, equals(true)),
      Ensure.that(WorkspaceUnchanged(), equals({ task: true, noOp: true, activeRelease: true })));
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'World objects Decode inspection and UI restoration failed; all failures retained');
});

test('World 侧栏普通与快速切换三轮：唯一当前链接与页面标题一致，世界设置不残留模型正文，原事实不变', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(OpenWorldWorkspace(), InspectWorldNavigation(),
      Ensure.that(WorkspaceOriginal().exact, equals(true)),
      Ensure.that(WorkspaceUnchanged(), equals({ task: true, noOp: true, activeRelease: true })));
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'World navigation and UI restoration failed; all failures retained');
});
