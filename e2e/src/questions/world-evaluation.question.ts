import { Question, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { WorldEvaluationPage } from '../pages/world-evaluation.page.js';

type EvaluationNotes = {
  worldEvaluation: {
    phase: string; mode: 'new-config' | 'existing-config' | null; selections: number; submissionAttempts: number; mayLeave: boolean;
    status: { outcome: string; world: { tenantId: string; worldId: string }; configured: boolean; commitId: string | null } | null;
  };
};
export const WorldEvaluationEvidence = () => notes<EvaluationNotes>().get('worldEvaluation');
export const EvaluationWorldHasSettled = () => Question.about('the existing World opens or reports an error', async actor =>
  await actor.answer(WorldEvaluationPage.statuses.count()) > 0 || await actor.answer(WorldEvaluationPage.errors.count()) > 0,
);
export const EvaluationWorldState = () => Question.about('the selected World is actually ready without errors', async actor => ({
  status: await actor.answer(WorldEvaluationPage.statuses.count()) === 1
    ? await actor.answer(Attribute.called('data-status').of(WorldEvaluationPage.status)) : null,
  errors: await actor.answer(Text.ofAll(WorldEvaluationPage.errors)),
}));
export const EvaluationIsIdle = () => Attribute.called('aria-busy').of(WorldEvaluationPage.body).as(value => value === 'false');
export const EvaluationStatusHasSettled = () => Question.about('evaluation configuration status is read, not merely mounted', async actor => {
  const messages = await actor.answer(Text.ofAll(WorldEvaluationPage.statusMessages));
  return messages.length > 0 && !messages.includes('配置状态尚未核对。') && !messages.includes('Configuration status has not been checked.');
});
export const EvaluationSummaryValues = () => Text.ofAll(WorldEvaluationPage.summaryValues);
export const EvaluationSummaryHasExactLabels = () => Text.ofAll(WorldEvaluationPage.summaryLabels).as(labels =>
  JSON.stringify(labels) === JSON.stringify(['组织 / 世界', '原提交编号', '身份记录数', '授权记录数', '访问策略数', '保留策略数', '案例访问策略 / 修订 / 标签', '案例保留策略 / 修订'])
  || JSON.stringify(labels) === JSON.stringify(['Organization / world', 'Original commit ID', 'Identity records', 'Grant records', 'Access policies', 'Retention policies', 'Case access policy / revision / labels', 'Case retention policy / revision']),
);
export const EvaluationIdentityValues = () => Text.ofAll(WorldEvaluationPage.identityValues);
export const EvaluationUiOutcome = () => Text.ofAll(WorldEvaluationPage.statusMessages).as(messages => messages.map(message => {
  if (message === '配置已保存' || message === 'Configuration saved') return 'configured';
  if (message === '尚未读到已保存配置；这不证明原提交失败或回滚。'
    || message === 'No saved configuration was observed. This does not establish failure or rollback of the original commit.') return 'not-configured';
  if (message === '已取消本次配置；不据此认定已有提交回滚。'
    || message === 'This configuration was cancelled. This does not establish rollback of an existing submission.') return 'cancelled';
  if (message === '原提交已确认；当前授权仍须另行核验。'
    || message === 'Original commit confirmed; current authorization still requires verification.') return 'confirmed';
  return message;
}));
export const EvaluationIssues = () => Text.ofAll(WorldEvaluationPage.issues);
export const EvaluationConfirmationIsExact = () => Text.of(WorldEvaluationPage.confirmationMessage).as(message =>
  message === '确认提交世界 local / personal 的评测配置（原提交 commit:eval-admin-ready-20261026-4e92d6a1）？任务执行者完成任务，独立判定者负责受保护答案与结果判定，二者使用隔离身份；实际访问仍须校验。此次确认不授予当前用户或 Agent 权限。'
  || message === 'Submit evaluation configuration for world local / personal with original commit commit:eval-admin-ready-20261026-4e92d6a1? The task executor performs the task; the independent judge handles protected answers and evaluates results, using a separate identity. Actual access still requires verification. This confirmation grants no permissions to the current user or an Agent.',
);
