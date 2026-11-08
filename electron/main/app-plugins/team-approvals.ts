import { isDeepStrictEqual } from 'node:util';
import { AppConfirmationUnavailableError, type AppPluginContext, type AppTeamApproval, type AppTeamApprovalResolveRequest, type AppTeamApprovalResolveResult, type AppTeamRunTarget } from '../../../sdk/app-plugins/src/api';
import { isRecord } from '../runtime-host-delivery/transport/client';
import { isProductRuntimeEndpoint } from '../runtime-host-delivery/transport/runtime-scope';
import type { TeamRuntimeTransport } from '../runtime-host-delivery/transport/teams/runtime';
import { AppPluginError } from './package';

type Confirm = AppPluginContext['requestConfirmation'];
const statuses = ['pending', 'approved', 'denied', 'aborted'];
const decisions = ['approve', 'deny', 'abort'];
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');

/** Only fields actually exposed by the native runSnapshot producer; never infer attempt fences. */
export function decodeTeamApprovals(value: unknown, target: AppTeamRunTarget): AppTeamApproval[] {
  if (!isRecord(value) || !isRecord(value.run) || value.run.teamId !== target.teamId || value.run.runId !== target.runId
    || !Array.isArray(value.approvals) || (Array.isArray(value.unavailableSections) && value.unavailableSections.includes('approvals'))) {
    throw new AppPluginError('busy', 'Team approvals are unavailable.');
  }
  const ids = new Set<string>();
  return value.approvals.map((item): AppTeamApproval => {
    if (!isRecord(item) || !text(item.approvalId) || ids.has(item.approvalId) || item.runId !== target.runId
      || typeof item.subject !== 'string' || !['stage', 'work_node', 'human_decision'].includes(item.subject)
      || (item.subject === 'stage' ? item.nodeId !== null : !text(item.nodeId))
      || !text(item.stageId) || !text(item.roleId) || !text(item.reason) || !text(item.requestedAction)
      || typeof item.status !== 'string' || !statuses.includes(item.status)
      || (item.decision !== null && (typeof item.decision !== 'string' || !decisions.includes(item.decision)))
      || !timestamp(item.createdAt) || (item.resolvedAt !== null && !timestamp(item.resolvedAt))) {
      throw new AppPluginError('busy', 'Team approval facts are unavailable.');
    }
    ids.add(item.approvalId);
    return {
      approvalId: item.approvalId, runId: target.runId, subject: item.subject as AppTeamApproval['subject'],
      nodeId: item.nodeId as string | null, stageId: item.stageId, roleId: item.roleId,
      reason: item.reason, requestedAction: item.requestedAction, status: item.status as AppTeamApproval['status'],
      decision: item.decision as AppTeamApproval['decision'], createdAt: item.createdAt, resolvedAt: item.resolvedAt as number | null,
    };
  });
}

export async function resolveTeamApproval(
  transport: TeamRuntimeTransport, input: AppTeamApprovalResolveRequest, signal: AbortSignal, confirm?: Confirm,
): Promise<AppTeamApprovalResolveResult> {
  if (!confirm) throw new AppConfirmationUnavailableError('Approval unavailable: an active tool call and foreground application are required.');
  if (!isProductRuntimeEndpoint(input.scope.endpoint)) throw new AppPluginError('invalid_package', 'Team approval requires a native runtime endpoint.');
  const scope = { kind: 'runtime-instance', endpoint: input.scope.endpoint };
  const read = async () => {
    signal.throwIfAborted();
    const response = await transport.execute({ id: 'team.runtime', operationId: 'team.runSnapshot', scope,
      target: { kind: 'team-run', runId: input.runId }, input: { runId: input.runId } });
    signal.throwIfAborted();
    if (response.status !== 200) throw new AppPluginError('busy', 'Team approvals are unavailable.');
    return decodeTeamApprovals(response.body, input).find(item => item.approvalId === input.approvalId);
  };
  const approval = await read();
  if (!approval || approval.status !== 'pending' || approval.subject === 'stage') return { outcome: 'target_rejected' };
  const column = { en: 0, zh: 1, ja: 2, ru: 3 }[input.language ?? 'en'];
  const label = (key: keyof typeof words) => words[key][column];
  const details = [
    { label: label('endpoint'), value: JSON.stringify(input.scope) },
    { label: label('team'), value: input.teamId }, { label: label('run'), value: input.runId },
    { label: label('approval'), value: approval.approvalId }, { label: label('subject'), value: approval.subject },
    { label: label('node'), value: approval.nodeId! }, { label: label('stage'), value: approval.stageId },
    { label: label('role'), value: approval.roleId }, { label: label('reason'), value: approval.reason },
    { label: label('action'), value: approval.requestedAction }, { label: label('created'), value: String(approval.createdAt) },
    { label: label('decision'), value: label(input.decision) },
    ...(input.note === undefined ? [] : [{ label: label('note'), value: input.note }]),
  ];
  if (!await confirm({ title: label('title'), description: label(approval.subject === 'human_decision' ? 'humanDecision' : 'workNode'),
    confirmLabel: label(input.decision), details }, signal)) return { outcome: 'cancelled' };
  signal.throwIfAborted();
  if (!isDeepStrictEqual(approval, await read())) return { outcome: 'target_rejected' };
  signal.throwIfAborted();
  try {
    const response = await transport.execute({ id: 'team.runtime', operationId: 'team.approvalResolve', scope,
      target: { kind: 'team-approval', runId: input.runId, approvalId: input.approvalId },
      input: { runId: input.runId, approvalId: input.approvalId, decision: input.decision, idempotencyKey: input.idempotencyKey,
        ...(input.note === undefined ? {} : { note: input.note }) } });
    if (response.status === 200 && isRecord(response.body) && response.body.success === true
      && (response.body.outcome === 'recorded' || response.body.outcome === 'replayed')) return { outcome: response.body.outcome };
    return { outcome: response.status === 400 ? 'target_rejected' : 'unknown' };
  } catch {
    // Once dispatched, neither cancellation nor a lost receipt proves the decision was not committed.
    return { outcome: 'unknown' };
  }
}

const words = {
  title: ['Review Team approval', '审核团队审批', 'チームの承認を確認', 'Рассмотрение запроса команды'],
  humanDecision: ['Confirm the decision for this native Team node. The Team routes its matching branch; this does not approve runtime tool permissions.', '确认此原生团队节点的决定，团队将推进对应分支；这不代替运行时工具权限审批', 'このチームノードの判断を確定します。対応する分岐へ進みますが、ツールの実行権限は付与しません。', 'Подтвердите решение для этого узла команды. Команда выберет соответствующую ветку; разрешения на инструменты не изменятся.'],
  workNode: ['Record a decision for this native Team work node. This does not resume the node, execute its action or grant runtime tool permissions.', '记录此原生团队工作节点的决定；不会自动恢复节点、执行操作或授予运行时工具权限', 'この作業ノードの判断を記録します。ノードの再開、操作の実行、ツール権限の付与は行いません。', 'Записать решение для рабочего узла команды. Это не возобновляет узел, не выполняет действие и не предоставляет разрешения на инструменты.'],
  approve: ['Approve request', '批准请求', 'リクエストを承認', 'Одобрить запрос'],
  deny: ['Deny request', '拒绝请求', 'リクエストを拒否', 'Отклонить запрос'],
  abort: ['Abort request', '终止请求', 'リクエストを中止', 'Прервать запрос'],
  endpoint: ['Runtime scope', '运行时范围', 'ランタイムの範囲', 'Область среды выполнения'],
  team: ['Team', '团队', 'チーム', 'Команда'], run: ['Run', '运行', '実行', 'Запуск'],
  approval: ['Approval', '审批', '承認', 'Запрос'], subject: ['Subject', '审批类型', '対象種別', 'Тип запроса'],
  node: ['Node', '节点', 'ノード', 'Узел'], stage: ['Stage', '阶段', 'ステージ', 'Этап'],
  role: ['Role', '角色', 'ロール', 'Роль'], reason: ['Reason', '原因', '理由', 'Причина'],
  action: ['Requested action', '请求操作', '要求された操作', 'Запрошенное действие'],
  created: ['Requested at', '请求时间', '要求日時', 'Время запроса'],
  decision: ['Decision', '决定', '判断', 'Решение'], note: ['Note', '备注', 'メモ', 'Примечание'],
} as const;
