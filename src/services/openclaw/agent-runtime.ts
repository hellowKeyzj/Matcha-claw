import type { GatewayRpcInvoker } from '@/services/openclaw/types';

interface AgentRunResult {
  runId?: unknown;
}

export interface AgentWaitResult {
  runId?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

export interface StartAgentRunInput {
  agentId: string;
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}

export interface WaitAgentRunInput {
  runId: string;
  waitSliceMs: number;
  maxWaitMs: number;
  rpcTimeoutBufferMs: number;
  logPrefix?: string;
}

const AGENT_WAIT_SUCCESS_STATUSES = new Set(['', 'ok', 'completed', 'done', 'success']);
const AGENT_WAIT_ERROR_STATUSES = new Set(['error', 'failed', 'aborted']);

export async function startAgentRun(
  rpc: GatewayRpcInvoker,
  input: StartAgentRunInput,
): Promise<{ runId: string }> {
  const run = await rpc<AgentRunResult>('agent', {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    message: input.message,
    idempotencyKey: input.idempotencyKey,
  });
  const runId = typeof run?.runId === 'string' ? run.runId.trim() : '';
  if (!runId) {
    throw new Error('agent returned empty runId');
  }
  return { runId };
}

export async function waitAgentRun(
  rpc: GatewayRpcInvoker,
  input: WaitAgentRunInput,
): Promise<AgentWaitResult> {
  const {
    runId,
    waitSliceMs,
    maxWaitMs,
    rpcTimeoutBufferMs,
    logPrefix = 'agent-wait',
  } = input;

  const startedAt = Date.now();
  let round = 0;

  while (Date.now() - startedAt < maxWaitMs) {
    round += 1;
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = maxWaitMs - elapsedMs;
    const currentSliceMs = Math.max(1000, Math.min(waitSliceMs, remainingMs));
    const rpcTimeoutMs = currentSliceMs + rpcTimeoutBufferMs;

    console.info(
      `[${logPrefix}] agent.wait start runId=${runId} round=${round} waitTimeoutMs=${currentSliceMs} rpcTimeoutMs=${rpcTimeoutMs} elapsedMs=${elapsedMs}`,
    );

    let result: AgentWaitResult;
    try {
      result = await rpc<AgentWaitResult>('agent.wait', { runId, timeoutMs: currentSliceMs }, rpcTimeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('RPC timeout: agent.wait') && Date.now() - startedAt < maxWaitMs) {
        console.warn(
          `[${logPrefix}] agent.wait rpc-timeout runId=${runId} round=${round} elapsedMs=${Date.now() - startedAt}, continue waiting`,
        );
        continue;
      }
      console.error(
        `[${logPrefix}] agent.wait failed runId=${runId} round=${round} elapsedMs=${Date.now() - startedAt} error=${message}`,
      );
      throw error;
    }

    const status = typeof result.status === 'string' ? result.status.toLowerCase() : '';
    if (AGENT_WAIT_SUCCESS_STATUSES.has(status)) {
      console.info(
        `[${logPrefix}] agent.wait ok runId=${runId} round=${round} elapsedMs=${Date.now() - startedAt} status=${status || 'ok'}`,
      );
      return result;
    }
    if (status === 'timeout') {
      console.info(
        `[${logPrefix}] agent.wait timeout-slice runId=${runId} round=${round} elapsedMs=${Date.now() - startedAt}, continue waiting`,
      );
      continue;
    }
    if (AGENT_WAIT_ERROR_STATUSES.has(status)) {
      const reason = typeof result.error === 'string' ? result.error.trim() : '';
      throw new Error(reason || `agent.wait returned ${status}`);
    }

    console.warn(
      `[${logPrefix}] agent.wait unknown-status runId=${runId} round=${round} status=${status || 'empty'}, continue waiting`,
    );
  }

  throw new Error(`Timed out waiting for agent run after ${maxWaitMs}ms`);
}
