import { parseReportFromText, type ParseReportDefaults } from '@/lib/report-parser';
import {
  startAgentRun,
  waitAgentRunWithProgress,
} from '@/lib/openclaw/agent-runtime';
import {
  deleteSession,
  fetchLatestAssistantSnapshot,
  fetchLatestAssistantText,
} from '@/lib/openclaw/session-runtime';
import type { TeamReport } from '@/types/team';

type RpcResult<T> = { success: boolean; result?: T; error?: string };

const AGENT_WAIT_SLICE_MS = 30000;
const AGENT_WAIT_NO_PROGRESS_TIMEOUT_MS = 180000;
const AGENT_WAIT_RPC_TIMEOUT_BUFFER_MS = 5000;

async function rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const res = await window.electron.ipcRenderer.invoke('gateway:rpc', method, params, timeoutMs) as RpcResult<T>;
  if (!res.success) {
    throw new Error(res.error || `RPC failed: ${method}`);
  }
  return res.result as T;
}

async function waitForAgentRun(runId: string, sessionKey: string): Promise<void> {
  await waitAgentRunWithProgress(rpc, {
    runId,
    sessionKey,
    waitSliceMs: AGENT_WAIT_SLICE_MS,
    idleTimeoutMs: AGENT_WAIT_NO_PROGRESS_TIMEOUT_MS,
    rpcTimeoutBufferMs: AGENT_WAIT_RPC_TIMEOUT_BUFFER_MS,
    logPrefix: 'team-orchestrator',
  });
}

export async function runAgentAndCollectReport(input: {
  agentId: string;
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}): Promise<TeamReport | null> {
  const result = await runAgentAndCollectReportWithRun(input);
  return result.report;
}

export async function runAgentAndCollectReportWithRun(input: {
  agentId: string;
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  reportDefaults?: ParseReportDefaults;
}): Promise<{ runId: string; text: string; report: TeamReport | null; usedTools?: string[] }> {
  const run = await startAgentRun(rpc, input);

  await waitForAgentRun(run.runId, input.sessionKey);

  const snapshot = await fetchLatestAssistantSnapshot(rpc, {
    sessionKey: input.sessionKey,
    limit: 20,
  });
  return {
    runId: run.runId,
    text: snapshot.text,
    report: parseReportFromText(snapshot.text, input.reportDefaults),
    usedTools: snapshot.toolNames,
  };
}

export async function runAgentAndCollectFinalOutput(input: {
  agentId: string;
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}): Promise<{ runId: string; text: string; usedTools?: string[] }> {
  const run = await startAgentRun(rpc, input);

  await waitForAgentRun(run.runId, input.sessionKey);

  const snapshot = await fetchLatestAssistantSnapshot(rpc, {
    sessionKey: input.sessionKey,
    limit: 20,
  });

  return {
    runId: run.runId,
    text: snapshot.text,
    usedTools: snapshot.toolNames,
  };
}

export async function runAgentAndCollectFinalText(input: {
  agentId: string;
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}): Promise<string> {
  const result = await runAgentAndCollectFinalOutput(input);
  if (result.text) {
    return result.text;
  }
  return fetchLatestAssistantText(rpc, {
    sessionKey: input.sessionKey,
    limit: 20,
  });
}

export async function broadcastDiscussionRound(input: {
  teamId: string;
  memberIds: string[];
  sessionKeyByAgent: Record<string, string>;
  message: string;
}): Promise<void> {
  await Promise.all(
    input.memberIds.map(async (agentId) => {
      const sessionKey = input.sessionKeyByAgent[agentId] ?? `agent:${agentId}:team:${input.teamId}`;
      await rpc('agent', {
        agentId,
        sessionKey,
        message: input.message,
        idempotencyKey: `${input.teamId}:${agentId}:${crypto.randomUUID()}`,
      });
    })
  );
}

export async function deleteTeamSessions(sessionKeys: string[]): Promise<void> {
  await Promise.all(sessionKeys.map(async (sessionKey) => {
    try {
      await deleteSession(rpc, { key: sessionKey, deleteTranscript: true });
    } catch {
      // Ignore missing sessions to make "exit chat" idempotent.
    }
  }));
}
