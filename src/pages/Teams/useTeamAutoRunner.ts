import { useEffect, useMemo, useState } from 'react';
import { invokeIpc } from '@/lib/api-client';
import { findLatestAssistantText, type ChatMessage } from '@/lib/openclaw/session-runtime';
import type { TeamMailboxMessage, TeamTask, TeamTaskStatus } from '@/lib/team/runtime-client';

const CLAIM_TICK_MS = 2_000;
const HEARTBEAT_TICK_MS = 20_000;
const CHAT_SEND_TIMEOUT_MS = 180_000;
const HISTORY_TIMEOUT_MS = 30_000;
const HISTORY_LIMIT = 20;
const SUMMARY_MAX_LENGTH = 400;

interface TeamAutoRunnerOptions {
  enabled: boolean;
  teamId?: string;
  memberIds: string[];
  getSessionKey: (agentId: string) => string;
  claimNext: (teamId: string, agentId: string, sessionKey: string) => Promise<TeamTask | null>;
  heartbeat: (teamId: string, taskId: string, agentId: string, sessionKey: string) => Promise<boolean>;
  updateTaskStatus: (
    teamId: string,
    taskId: string,
    status: TeamTaskStatus,
    options?: { resultSummary?: string; error?: string },
  ) => Promise<void>;
  releaseClaim: (teamId: string, taskId: string, agentId: string, sessionKey: string) => Promise<void>;
  postMailbox: (
    teamId: string,
    message: Omit<TeamMailboxMessage, 'createdAt'> & { createdAt?: number },
  ) => Promise<void>;
}

interface TeamAutoRunnerState {
  activeAgentIds: string[];
  lastError: string | null;
}

interface GatewayRpcResponse<T> {
  success: boolean;
  result?: T;
  error?: string;
}

function generateId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

async function callGatewayRpc<T>(
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  const response = await invokeIpc<GatewayRpcResponse<T>>(
    'gateway:rpc',
    method,
    params,
    timeoutMs,
  );
  if (!response?.success) {
    throw new Error(response?.error || `Gateway RPC failed: ${method}`);
  }
  return response.result as T;
}

async function fetchLatestAssistantSummary(sessionKey: string): Promise<string> {
  const history = await callGatewayRpc<{ messages?: ChatMessage[] }>(
    'chat.history',
    {
      sessionKey,
      limit: HISTORY_LIMIT,
    },
    HISTORY_TIMEOUT_MS,
  );
  return summarizeAssistantText(findLatestAssistantText(history.messages));
}

export function useTeamAutoRunner(options: TeamAutoRunnerOptions): TeamAutoRunnerState {
  const {
    enabled,
    teamId,
    memberIds,
    getSessionKey,
    claimNext,
    heartbeat,
    updateTaskStatus,
    releaseClaim,
    postMailbox,
  } = options;

  const [activeAgentIds, setActiveAgentIds] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  const sortedMemberIds = useMemo(
    () => Array.from(new Set(memberIds)).sort(),
    [memberIds],
  );

  useEffect(() => {
    if (!enabled || !teamId || sortedMemberIds.length === 0) {
      setActiveAgentIds([]);
      return;
    }

    let disposed = false;
    const busyAgentIds = new Set<string>();

    const markAgentActive = (agentId: string, active: boolean) => {
      setActiveAgentIds((prev) => {
        if (active) {
          return prev.includes(agentId) ? prev : [...prev, agentId];
        }
        return prev.filter((id) => id !== agentId);
      });
    };

    const runOnceForAgent = async (agentId: string) => {
      if (!teamId || disposed) {
        return;
      }
      const sessionKey = getSessionKey(agentId);
      const claimedTask = await claimNext(teamId, agentId, sessionKey);
      if (!claimedTask || disposed) {
        return;
      }

      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      const heartbeatOnce = async () => {
        try {
          await heartbeat(teamId, claimedTask.taskId, agentId, sessionKey);
        } catch {
          // 续租失败不立即中断执行，最终状态更新会反映失败。
        }
      };

      try {
        await updateTaskStatus(teamId, claimedTask.taskId, 'running');

        heartbeatTimer = setInterval(() => {
          void heartbeatOnce();
        }, HEARTBEAT_TICK_MS);

        await callGatewayRpc(
          'chat.send',
          {
            sessionKey,
            message: buildRunnerPrompt(claimedTask),
            deliver: false,
            idempotencyKey: generateId(),
          },
          CHAT_SEND_TIMEOUT_MS,
        );

        const summary = await fetchLatestAssistantSummary(sessionKey);
        const resultSummary = summary || '自动执行完成';
        await updateTaskStatus(teamId, claimedTask.taskId, 'done', { resultSummary });

        await postMailbox(teamId, {
          msgId: `report-${generateId()}`,
          fromAgentId: agentId,
          to: 'broadcast',
          kind: 'report',
          relatedTaskId: claimedTask.taskId,
          content: `任务 ${claimedTask.taskId} 已完成。\n结果摘要: ${resultSummary}`,
          createdAt: Date.now(),
        });
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        setLastError(errorMessage);
        try {
          await updateTaskStatus(teamId, claimedTask.taskId, 'failed', { error: errorMessage });
        } catch {
          // 任务状态更新失败时忽略，避免中断 runner 循环。
        }
        try {
          await postMailbox(teamId, {
            msgId: `report-${generateId()}`,
            fromAgentId: agentId,
            to: 'broadcast',
            kind: 'report',
            relatedTaskId: claimedTask.taskId,
            content: `任务 ${claimedTask.taskId} 执行失败：${errorMessage}`,
            createdAt: Date.now(),
          });
        } catch {
          // 邮件投递失败不影响后续循环。
        }
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        try {
          await releaseClaim(teamId, claimedTask.taskId, agentId, sessionKey);
        } catch {
          // 释放失败可由租约超时回收。
        }
      }
    };

    const tick = () => {
      if (disposed) {
        return;
      }
      for (const agentId of sortedMemberIds) {
        if (busyAgentIds.has(agentId)) {
          continue;
        }
        busyAgentIds.add(agentId);
        markAgentActive(agentId, true);
        void runOnceForAgent(agentId)
          .catch((error) => {
            setLastError(toErrorMessage(error));
          })
          .finally(() => {
            busyAgentIds.delete(agentId);
            markAgentActive(agentId, false);
          });
      }
    };

    tick();
    const timer = setInterval(tick, CLAIM_TICK_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      setActiveAgentIds([]);
    };
  }, [
    claimNext,
    enabled,
    getSessionKey,
    heartbeat,
    postMailbox,
    releaseClaim,
    sortedMemberIds,
    teamId,
    updateTaskStatus,
  ]);

  return {
    activeAgentIds,
    lastError,
  };
}
