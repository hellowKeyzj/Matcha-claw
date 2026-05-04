import { hostGatewayRpc } from '@/lib/host-api';
import { waitAgentRunWithProgress } from '@/services/openclaw/agent-runtime';
import {
  fetchChatTimeline,
  sendChatMessage,
} from '@/services/openclaw/session-runtime';
import type { TeamMailboxMessage, TeamTask } from '@/features/teams/api/runtime-client';
import { deriveAutoBlockedDecision, deriveTaskTitleFromProposal, parseBlockedDecision } from '@/features/teams/domain/runner-automation';
import { useGatewayStore } from '@/stores/gateway';
import type { TeamMeta } from '@/stores/teams';
import { useTeamsStore } from '@/stores/teams';
import { useTeamsRunnerStore } from '@/stores/teams-runner';
import { findLatestAssistantTextFromItems } from '@/stores/chat/timeline-message';
import type { SessionRenderItem } from '../../../../runtime-host/shared/session-adapter-types';

const ORCHESTRATOR_TICK_ACTIVE_MS = 2_500;
const ORCHESTRATOR_TICK_IDLE_MS = 8_000;
const ORCHESTRATOR_TICK_BACKGROUND_MS = 20_000;
const SNAPSHOT_REFRESH_ACTIVE_MS = 3_000;
const SNAPSHOT_REFRESH_IDLE_MS = 10_000;
const SNAPSHOT_REFRESH_BACKGROUND_MS = 25_000;
const HEARTBEAT_TICK_MS = 20_000;
const HISTORY_LIMIT = 20;
const SUMMARY_MAX_LENGTH = 400;
const RESULT_POLL_INTERVAL_MS = 1_500;
const RESULT_WAIT_TIMEOUT_MS = 180_000;
const AGENT_WAIT_SLICE_MS = 30_000;
const AGENT_WAIT_RPC_TIMEOUT_BUFFER_MS = 10_000;
const BLOCKED_AUTO_ARBITRATION_DELAY_MS = 15_000;

interface AssistantProgress {
  assistantCount: number;
  latestSummary: string;
}

function generateId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildTaskId(): string {
  return `task-auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function summarizeAssistantText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  const normalized = trimmed.replace(/\s+/g, ' ');
  if (normalized.length <= SUMMARY_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, SUMMARY_MAX_LENGTH)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function callGatewayRpc<T>(
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  return await hostGatewayRpc<T>(method, params, timeoutMs);
}

async function gatewayRpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  return callGatewayRpc<T>(method, params, timeoutMs ?? 30_000);
}

function readAssistantProgress(items?: SessionRenderItem[]): AssistantProgress {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      assistantCount: 0,
      latestSummary: '',
    };
  }
  let assistantCount = 0;
  for (const item of items) {
    if (item.kind === 'assistant-turn') {
      assistantCount += 1;
    }
  }
  return {
    assistantCount,
    latestSummary: summarizeAssistantText(findLatestAssistantTextFromItems(items)),
  };
}

async function fetchAssistantProgress(sessionKey: string): Promise<AssistantProgress> {
  const items = await fetchChatTimeline({
    sessionKey,
    limit: HISTORY_LIMIT,
  });
  return readAssistantProgress(items);
}

async function waitForNextAssistantSummary(
  sessionKey: string,
  baseline: AssistantProgress,
): Promise<string> {
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < RESULT_WAIT_TIMEOUT_MS) {
    try {
      const current = await fetchAssistantProgress(sessionKey);
      if (current.assistantCount > baseline.assistantCount) {
        return current.latestSummary || '自动执行完成';
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(RESULT_POLL_INTERVAL_MS);
  }

  if (lastError) {
    throw new Error(`等待自动执行结果超时: ${toErrorMessage(lastError)}`);
  }
  throw new Error('等待自动执行结果超时');
}

function buildRunnerPrompt(task: TeamTask): string {
  const lines = [
    '你现在在团队自动执行模式中，请完成以下任务。',
    `任务ID: ${task.taskId}`,
    `任务标题: ${task.title || '(无标题)'}`,
    '任务指令:',
    task.instruction,
  ];
  if (task.dependsOn.length > 0) {
    lines.push(`依赖任务: ${task.dependsOn.join(', ')}`);
  }
  lines.push(
    '',
    '输出要求：',
    '1. 直接给出执行结果，不要解释流程细节。',
    '2. 末尾使用“结果摘要:”开头，给出不超过 200 字摘要。',
  );
  return lines.join('\n');
}

function sessionKey(agentId: string, teamId: string): string {
  return `agent:${agentId}:team:${teamId}:exec`;
}

function selectLatestDecisionMessage(mailbox: TeamMailboxMessage[], taskId: string): TeamMailboxMessage | null {
  const list = mailbox
    .filter((message) => message.kind === 'decision' && message.relatedTaskId === taskId)
    .sort((a, b) => a.createdAt - b.createdAt);
  return list.length > 0 ? list[list.length - 1]! : null;
}

function hasBlockedQuestion(mailbox: TeamMailboxMessage[], taskId: string): boolean {
  return mailbox.some(
    (message) => message.kind === 'question'
      && message.relatedTaskId === taskId
      && message.content.includes('[AUTO-BLOCKED]'),
  );
}

export class TeamsBackgroundOrchestrator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busyAgentKeys = new Set<string>();
  private lastRefreshAtByTeamId = new Map<string, number>();
  private planningHandledByMessageId = new Set<string>();
  private tickRunning = false;
  private visibilityHandlerBound = false;

  private handleVisibilityChange = () => {
    if (!useTeamsRunnerStore.getState().daemonRunning) {
      return;
    }
    this.scheduleNextTick(0);
  };

  private isDocumentVisible(): boolean {
    if (typeof document === 'undefined') {
      return true;
    }
    return document.visibilityState === 'visible';
  }

  start(): void {
    if (this.timer) {
      return;
    }
    useTeamsRunnerStore.getState().setDaemonRunning(true);
    if (!this.visibilityHandlerBound && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
      this.visibilityHandlerBound = true;
    }
    this.scheduleNextTick(0);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.visibilityHandlerBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      this.visibilityHandlerBound = false;
    }
    this.busyAgentKeys.clear();
    this.lastRefreshAtByTeamId.clear();
    useTeamsRunnerStore.getState().resetRuntimeState();
    useTeamsRunnerStore.getState().setDaemonRunning(false);
  }

  private isGatewayRunning(): boolean {
    return useGatewayStore.getState().status.state === 'running';
  }

  private hasActiveWorkForTeam(teamId: string): boolean {
    const tasks = this.getTeamTasks(teamId);
    return tasks.some((task) => (
      task.status === 'todo'
      || task.status === 'claimed'
      || task.status === 'running'
      || task.status === 'blocked'
    ));
  }

  private hasAnyActiveWork(): boolean {
    const teamsStore = useTeamsStore.getState();
    const runnerStore = useTeamsRunnerStore.getState();
    for (const team of teamsStore.teams) {
      if (!runnerStore.isTeamEnabled(team.id)) {
        continue;
      }
      if (this.hasActiveWorkForTeam(team.id)) {
        return true;
      }
      const activeAgents = runnerStore.activeAgentIdsByTeamId[team.id] ?? [];
      if (activeAgents.length > 0) {
        return true;
      }
    }
    return false;
  }

  private resolveTickIntervalMs(): number {
    if (!this.isDocumentVisible()) {
      return ORCHESTRATOR_TICK_BACKGROUND_MS;
    }
    return this.hasAnyActiveWork() ? ORCHESTRATOR_TICK_ACTIVE_MS : ORCHESTRATOR_TICK_IDLE_MS;
  }

  private resolveSnapshotRefreshIntervalMs(teamId: string): number {
    if (!this.isDocumentVisible()) {
      return SNAPSHOT_REFRESH_BACKGROUND_MS;
    }
    return this.hasActiveWorkForTeam(teamId) ? SNAPSHOT_REFRESH_ACTIVE_MS : SNAPSHOT_REFRESH_IDLE_MS;
  }

  private scheduleNextTick(delayMs?: number): void {
    if (!useTeamsRunnerStore.getState().daemonRunning) {
      return;
    }
    const delay = typeof delayMs === 'number' ? delayMs : this.resolveTickIntervalMs();
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (!useTeamsRunnerStore.getState().daemonRunning) {
          return;
        }
        this.scheduleNextTick();
      });
    }, delay);
  }

  private async ensureFreshSnapshot(teamId: string): Promise<void> {
    const now = Date.now();
    const lastAt = this.lastRefreshAtByTeamId.get(teamId) ?? 0;
    if (now - lastAt < this.resolveSnapshotRefreshIntervalMs(teamId)) {
      return;
    }
    this.lastRefreshAtByTeamId.set(teamId, now);
    const store = useTeamsStore.getState();
    await Promise.all([
      store.refreshSnapshot(teamId),
      store.pullMailbox(teamId, 200),
    ]);
  }

  private getTeamTasks(teamId: string): TeamTask[] {
    return useTeamsStore.getState().tasksByTeamId[teamId] ?? [];
  }

  private getTeamMailbox(teamId: string): TeamMailboxMessage[] {
    return useTeamsStore.getState().mailboxByTeamId[teamId] ?? [];
  }

  private buildAgentBusyKey(teamId: string, agentId: string): string {
    return `${teamId}:${agentId}`;
  }

  private async applyDecision(
    team: TeamMeta,
    task: TeamTask,
    action: 'retry' | 'fail',
    reason: string,
    byAgentId: string,
  ): Promise<void> {
    const store = useTeamsStore.getState();
    if (action === 'retry') {
      await store.updateTaskStatus(team.id, task.taskId, 'todo');
      await store.postMailbox(team.id, {
        msgId: `report-${generateId()}`,
        fromAgentId: byAgentId,
        to: 'broadcast',
        kind: 'report',
        relatedTaskId: task.taskId,
        content: `任务 ${task.taskId} 已执行恢复决策：重试。\n原因：${reason}`,
        createdAt: Date.now(),
      });
      return;
    }
    await store.updateTaskStatus(team.id, task.taskId, 'failed', { error: reason });
    await store.postMailbox(team.id, {
      msgId: `report-${generateId()}`,
      fromAgentId: byAgentId,
      to: 'broadcast',
      kind: 'report',
      relatedTaskId: task.taskId,
      content: `任务 ${task.taskId} 已执行终止决策：标记失败。\n原因：${reason}`,
      createdAt: Date.now(),
    });
  }

  private async ensureBlockedQuestionPosted(team: TeamMeta, task: TeamTask, errorMessage: string): Promise<void> {
    const store = useTeamsStore.getState();
    const mailbox = this.getTeamMailbox(team.id);
    if (hasBlockedQuestion(mailbox, task.taskId)) {
      return;
    }
    await store.postMailbox(team.id, {
      msgId: `question-${generateId()}`,
      fromAgentId: task.ownerAgentId || team.leadAgentId,
      to: team.leadAgentId,
      kind: 'question',
      relatedTaskId: task.taskId,
      content: `[AUTO-BLOCKED] 任务 ${task.taskId} 执行受阻，请决策：回复 retry/resume 或 fail/cancel。\n错误：${errorMessage}`,
      createdAt: Date.now(),
    });
  }

  private async processBlockedLoop(team: TeamMeta): Promise<void> {
    const store = useTeamsStore.getState();
    const tasks = this.getTeamTasks(team.id);
    const mailbox = this.getTeamMailbox(team.id);
    const blockedTasks = tasks.filter((task) => task.status === 'blocked');
    if (blockedTasks.length === 0) {
      return;
    }

    for (const task of blockedTasks) {
      const decisionMsg = selectLatestDecisionMessage(mailbox, task.taskId);
      if (decisionMsg) {
        const action = parseBlockedDecision(decisionMsg.content);
        if (action) {
          await this.applyDecision(
            team,
            task,
            action,
            decisionMsg.content,
            decisionMsg.fromAgentId || team.leadAgentId,
          );
          continue;
        }
      }

      if (!hasBlockedQuestion(mailbox, task.taskId)) {
        await this.ensureBlockedQuestionPosted(team, task, task.error || '执行失败');
      }

      if (Date.now() - task.updatedAt < BLOCKED_AUTO_ARBITRATION_DELAY_MS) {
        continue;
      }

      const auto = deriveAutoBlockedDecision(task);
      await store.postMailbox(team.id, {
        msgId: `decision-${generateId()}`,
        fromAgentId: team.leadAgentId,
        to: task.ownerAgentId || 'broadcast',
        kind: 'decision',
        relatedTaskId: task.taskId,
        content: `[AUTO-DECISION] ${auto.action.toUpperCase()} - ${auto.reason}`,
        createdAt: Date.now(),
      });
      await this.applyDecision(team, task, auto.action, auto.reason, team.leadAgentId);
    }
  }

  private async processLeadPlanning(team: TeamMeta): Promise<void> {
    const store = useTeamsStore.getState();
    const tasks = this.getTeamTasks(team.id);
    const mailbox = this.getTeamMailbox(team.id);
    const proposalMessages = mailbox
      .filter((message) => message.kind === 'proposal' && message.to === 'broadcast' && !message.relatedTaskId)
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const message of proposalMessages) {
      const handledKey = `${team.id}:${message.msgId}`;
      if (this.planningHandledByMessageId.has(handledKey)) {
        continue;
      }
      const alreadyPlanned = mailbox.some(
        (row) => row.kind === 'decision'
          && row.replyToMsgId === message.msgId
          && row.fromAgentId === team.leadAgentId,
      );
      if (alreadyPlanned) {
        this.planningHandledByMessageId.add(handledKey);
        continue;
      }

      const newTaskId = buildTaskId();
      const nextTasks = [
        ...tasks.map((task) => ({
          taskId: task.taskId,
          title: task.title,
          instruction: task.instruction,
          dependsOn: task.dependsOn,
        })),
        {
          taskId: newTaskId,
          title: deriveTaskTitleFromProposal(message.content),
          instruction: message.content,
          dependsOn: [] as string[],
        },
      ];
      await store.planUpsert(team.id, nextTasks);
      await store.postMailbox(team.id, {
        msgId: `decision-${generateId()}`,
        fromAgentId: team.leadAgentId,
        to: 'broadcast',
        kind: 'decision',
        relatedTaskId: newTaskId,
        replyToMsgId: message.msgId,
        content: `已自动规划任务 ${newTaskId}，请成员认领执行。`,
        createdAt: Date.now(),
      });
      this.planningHandledByMessageId.add(handledKey);
      break;
    }
  }

  private async runTaskForAgent(team: TeamMeta, agentId: string): Promise<void> {
    const busyKey = this.buildAgentBusyKey(team.id, agentId);
    if (this.busyAgentKeys.has(busyKey)) {
      return;
    }
    this.busyAgentKeys.add(busyKey);
    const runtimeStore = useTeamsRunnerStore.getState();
    runtimeStore.markAgentActive(team.id, agentId, true);

    const teamsStore = useTeamsStore.getState();
    const execSessionKey = sessionKey(agentId, team.id);

    let claimedTask = await teamsStore.claimNext(team.id, agentId, execSessionKey);
    if (!claimedTask) {
      const tasks = this.getTeamTasks(team.id);
      claimedTask = tasks.find((task) => (
        task.status === 'claimed'
        && task.ownerAgentId === agentId
        && (!task.claimSessionKey || task.claimSessionKey === execSessionKey)
      )) ?? null;
    }
    if (!claimedTask) {
      runtimeStore.markAgentTask(team.id, agentId);
      runtimeStore.markAgentActive(team.id, agentId, false);
      this.busyAgentKeys.delete(busyKey);
      return;
    }
    runtimeStore.markAgentTask(team.id, agentId, claimedTask.taskId);

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const heartbeat = async () => {
      try {
        await useTeamsStore.getState().heartbeat(team.id, claimedTask!.taskId, agentId, execSessionKey);
      } catch {
        // 续租失败不立即中断，最终由状态流转兜底。
      }
    };

    try {
      const baseline = await fetchAssistantProgress(execSessionKey);
      await useTeamsStore.getState().updateTaskStatus(team.id, claimedTask.taskId, 'running');

      heartbeatTimer = setInterval(() => {
        void heartbeat();
      }, HEARTBEAT_TICK_MS);

      const sendResult = await sendChatMessage({
        sessionKey: execSessionKey,
        message: buildRunnerPrompt(claimedTask),
        deliver: false,
        idempotencyKey: generateId(),
      });

      const runId = typeof sendResult?.runId === 'string' ? sendResult.runId.trim() : '';
      if (runId) {
        await waitAgentRunWithProgress(gatewayRpc, {
          runId,
          sessionKey: execSessionKey,
          waitSliceMs: AGENT_WAIT_SLICE_MS,
          idleTimeoutMs: RESULT_WAIT_TIMEOUT_MS,
          rpcTimeoutBufferMs: AGENT_WAIT_RPC_TIMEOUT_BUFFER_MS,
          logPrefix: 'teams.daemon',
        });
      }

      let resultSummary = '';
      if (runId) {
        const finalProgress = await fetchAssistantProgress(execSessionKey);
        if (finalProgress.assistantCount <= baseline.assistantCount) {
          throw new Error('任务执行结束但未产生新的助手回复，已转入阻塞等待决策。');
        }
        resultSummary = finalProgress.latestSummary || '自动执行完成';
      } else {
        resultSummary = await waitForNextAssistantSummary(execSessionKey, baseline);
      }

      await useTeamsStore.getState().updateTaskStatus(team.id, claimedTask.taskId, 'done', { resultSummary });
      await useTeamsStore.getState().postMailbox(team.id, {
        msgId: `report-${generateId()}`,
        fromAgentId: agentId,
        to: 'broadcast',
        kind: 'report',
        relatedTaskId: claimedTask.taskId,
        content: `任务 ${claimedTask.taskId} 已完成。\n结果摘要: ${resultSummary}`,
        createdAt: Date.now(),
      });
      runtimeStore.setTeamError(team.id, undefined);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      runtimeStore.setTeamError(team.id, errorMessage);
      await useTeamsStore.getState().updateTaskStatus(team.id, claimedTask.taskId, 'blocked', { error: errorMessage });
      await this.ensureBlockedQuestionPosted(team, claimedTask, errorMessage);
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      try {
        await useTeamsStore.getState().releaseClaim(team.id, claimedTask.taskId, agentId, execSessionKey);
      } catch {
        // ignore
      }
      runtimeStore.markAgentTask(team.id, agentId);
      runtimeStore.markAgentActive(team.id, agentId, false);
      this.busyAgentKeys.delete(busyKey);
    }
  }

  private async tickTeam(team: TeamMeta): Promise<void> {
    const runnerStore = useTeamsRunnerStore.getState();
    const teamsStore = useTeamsStore.getState();
    if (!runnerStore.isTeamEnabled(team.id)) {
      runnerStore.clearTeamRuntimeState(team.id);
      return;
    }

    let runMeta = teamsStore.runMetaByTeamId[team.id];
    if (!runMeta) {
      try {
        await teamsStore.initRuntime(team.id);
      } catch (error) {
        runnerStore.clearTeamRuntimeState(team.id);
        runnerStore.setTeamError(team.id, toErrorMessage(error));
        return;
      }
      runMeta = useTeamsStore.getState().runMetaByTeamId[team.id];
    }

    if (!runMeta || runMeta.status !== 'active') {
      runnerStore.clearTeamRuntimeState(team.id);
      return;
    }

    await this.ensureFreshSnapshot(team.id);
    await this.processLeadPlanning(team);
    await this.processBlockedLoop(team);
    await this.ensureFreshSnapshot(team.id);

    for (const agentId of team.memberIds) {
      void this.runTaskForAgent(team, agentId);
    }
  }

  private async tick(): Promise<void> {
    if (this.tickRunning) {
      return;
    }
    if (!useTeamsRunnerStore.getState().daemonRunning) {
      return;
    }
    this.tickRunning = true;
    try {
      if (!this.isGatewayRunning()) {
        useTeamsRunnerStore.getState().resetRuntimeState();
        return;
      }

      const teamsStore = useTeamsStore.getState();
      const teams = teamsStore.teams;
      useTeamsRunnerStore.getState().pruneTeams(teams.map((team) => team.id));

      for (const team of teams) {
        try {
          await this.tickTeam(team);
        } catch (error) {
          useTeamsRunnerStore.getState().setTeamError(team.id, toErrorMessage(error));
        }
      }
    } finally {
      this.tickRunning = false;
    }
  }
}

export const teamsBackgroundOrchestrator = new TeamsBackgroundOrchestrator();
