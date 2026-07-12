import type {
  RuntimeAbortRequest,
  RuntimeEndpointReadiness,
  RuntimeEnsureSessionRequest,
  RuntimeEnsureSessionResult,
  RuntimeExternalSessionListRequest,
  RuntimeExternalSessionListResult,
  RuntimeExternalSessionTranscriptRequest,
  RuntimeExternalSessionTranscriptResult,
  RuntimePatchModelRequest,
  RuntimePatchModelResult,
  RuntimePromptRequest,
  RuntimePromptResult,
  RuntimeResolveApprovalRequest,
  RuntimeSessionContext,
  RuntimeSessionTransport,
  RuntimeStartSessionEventsRequest,
} from '../../../agent-runtime/contracts/runtime-endpoint-types';
import type { SessionApprovalDecision } from '../../../../shared/session-adapter-types';
import { MatchaAgentAppServerClient } from './matcha-agent-app-server-client';
import { MatchaAgentEventBridge } from './matcha-agent-event-bridge';
import { InMemoryMatchaAgentSessionCheckpointStore } from './matcha-agent-session-checkpoint-store';
import type { MatchaTerminalDeliveryTrace } from '../../../../shared/matcha-terminal-delivery-trace';

export class MatchaAgentRuntimeTransport implements RuntimeSessionTransport {
  private readonly eventBridgesBySessionId = new Map<string, MatchaAgentEventBridge>();
  private readonly ensuredSessionIds = new Set<string>();

  constructor(
    private readonly client: MatchaAgentAppServerClient,
    private readonly checkpoints: InMemoryMatchaAgentSessionCheckpointStore = new InMemoryMatchaAgentSessionCheckpointStore(),
    private readonly terminalDeliveryTrace?: MatchaTerminalDeliveryTrace,
  ) {}

  async ensureSession(input: RuntimeEnsureSessionRequest): Promise<RuntimeEnsureSessionResult> {
    const sessionId = input.context.endpointSessionId;
    try {
      if (this.ensuredSessionIds.has(sessionId)) {
        await this.client.request('session.load', { sessionId });
        return { success: true };
      }
      await this.client.request('session.load', { sessionId });
      this.ensuredSessionIds.add(sessionId);
      return { success: true };
    } catch (loadError) {
      if (!isSessionNotFoundError(loadError)) {
        return { success: false, error: errorToMessage(loadError) };
      }
      try {
        await this.client.request('session.create', {
          sessionId,
          cwd: input.cwd,
          ...(input.title ? { title: input.title } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        });
        this.ensuredSessionIds.add(sessionId);
        return { success: true };
      } catch (createError) {
        if (!isDuplicateSessionError(createError)) {
          return { success: false, error: errorToMessage(createError) };
        }
        try {
          await this.client.request('session.load', { sessionId });
          this.ensuredSessionIds.add(sessionId);
          return { success: true };
        } catch (duplicateLoadError) {
          return { success: false, error: errorToMessage(duplicateLoadError) };
        }
      }
    }
  }

  async startSessionEvents(input: RuntimeStartSessionEventsRequest): Promise<void> {
    const sessionId = input.context.endpointSessionId;
    if (this.eventBridgesBySessionId.has(sessionId)) return;
    const bridge = new MatchaAgentEventBridge(this.client, this.checkpoints, this.terminalDeliveryTrace);
    this.eventBridgesBySessionId.set(sessionId, bridge);
    try {
      await bridge.start({
        sessionId,
        consume: (eventEnvelope) => input.consume(
          normalizeSessionEventEnvelope(eventEnvelope, input.context.endpointSessionId),
        ),
      });
    } catch (error) {
      this.eventBridgesBySessionId.delete(sessionId);
      bridge.stop();
      throw error;
    }
  }

  stopSessionEvents(context: RuntimeSessionContext): void {
    const sessionId = context.endpointSessionId;
    this.eventBridgesBySessionId.get(sessionId)?.stop();
    this.eventBridgesBySessionId.delete(sessionId);
  }

  async listExternalSessions(_input: RuntimeExternalSessionListRequest): Promise<RuntimeExternalSessionListResult> {
    const payload = await this.client.request('session.list', {});
    const record = asRecord(payload);
    const sessions = Array.isArray(record?.sessions)
      ? record.sessions
        .filter(hasConversation)
        .map(readExternalSession)
        .filter((session): session is RuntimeExternalSessionListResult['sessions'][number] => session !== null)
      : [];
    return { sessions };
  }

  async readExternalSessionTranscript(input: RuntimeExternalSessionTranscriptRequest): Promise<RuntimeExternalSessionTranscriptResult> {
    const payload = await this.client.request('session.transcript', {
      sessionId: input.context.endpointSessionId,
    });
    const record = asRecord(payload);
    const lines = Array.isArray(record?.lines)
      ? record.lines.filter((line): line is string => typeof line === 'string')
      : [];
    return { transcript: lines };
  }

  async sendPrompt(input: RuntimePromptRequest): Promise<RuntimePromptResult> {
    try {
      const payload = await this.client.request('session.prompt', {
        sessionId: input.context.endpointSessionId,
        prompt: input.message,
        runId: input.runId,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      });
      return {
        success: true,
        payload,
      };
    } catch (error) {
      return {
        success: false,
        error: errorToMessage(error),
      };
    }
  }

  async abortSession(input: RuntimeAbortRequest): Promise<void> {
    await this.client.request('session.cancel', {
      sessionId: input.context.endpointSessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      reason: 'runtime-host abortSession',
    });
  }

  async resolveApproval(input: RuntimeResolveApprovalRequest): Promise<unknown> {
    return await this.client.request('approval.respond', {
      sessionId: input.context.endpointSessionId,
      approvalId: input.id,
      optionId: resolveApprovalOptionId(input),
      ...(input.decision === 'deny' ? { reason: 'Denied by runtime-host approval decision' } : {}),
    });
  }

  async patchSessionModel(input: RuntimePatchModelRequest): Promise<RuntimePatchModelResult> {
    const payload = await this.client.request('session.setModel', {
      sessionId: input.context.endpointSessionId,
      model: input.runtimeModelRef,
    });
    return {
      runtimeModelRef: input.runtimeModelRef,
      payload,
    };
  }

  async inspectReadiness(): Promise<RuntimeEndpointReadiness> {
    try {
      const health = await this.client.inspectHealth();
      if (!health.ok) {
        return {
          ready: false,
          phase: 'unavailable',
          error: 'matcha-agent app-server health check is not ok',
          details: health.payload,
        };
      }
      const initialize = await this.client.initialize();
      return {
        ready: true,
        phase: 'ready',
        details: {
          health: health.payload,
          initialize: initialize.payload,
        },
      };
    } catch (error) {
      return {
        ready: false,
        phase: 'unavailable',
        error: errorToMessage(error),
      };
    }
  }
}

function hasConversation(value: unknown): boolean {
  return asRecord(value)?.hasConversation === true;
}

function readExternalSession(value: unknown): RuntimeExternalSessionListResult['sessions'][number] | null {
  const record = asRecord(value);
  const endpointSessionId = typeof record?.sessionId === 'string' ? record.sessionId.trim() : '';
  if (!endpointSessionId) {
    return null;
  }
  const label = normalizeOptionalString(record.title);
  const runtimeModelRef = normalizeOptionalString(record.model);
  const updatedAt = readTimestampMs(record.updatedAt) ?? readTimestampMs(record.createdAt);
  return {
    endpointSessionId,
    status: readExternalSessionStatus(record.workerState),
    ...(label ? { label } : {}),
    ...(runtimeModelRef ? { runtimeModelRef } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function readExternalSessionStatus(workerState: unknown): RuntimeExternalSessionListResult['sessions'][number]['status'] {
  const state = asRecord(workerState)?.state;
  return state === 'running' || state === 'waitingForApproval' || state === 'spawning' || state === 'ready'
    ? 'active'
    : 'completed';
}

function readTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeSessionEventEnvelope(eventEnvelope: unknown, endpointSessionId: string): Record<string, unknown> {
  return {
    ...(eventEnvelope as Record<string, unknown>),
    sessionKey: endpointSessionId,
  };
}

function resolveApprovalOptionId(input: RuntimeResolveApprovalRequest): string {
  return approvalDecisionToOptionId(input.decision);
}

function approvalDecisionToOptionId(decision: SessionApprovalDecision): string {
  switch (decision) {
    case 'allow-once':
      return 'allow_once';
    case 'allow-always':
      return 'allow_always';
    case 'deny':
      return 'reject_once';
  }
}

function isDuplicateSessionError(error: unknown): boolean {
  return errorToMessage(error).includes('Session already exists');
}

function isSessionNotFoundError(error: unknown): boolean {
  return errorToMessage(error).startsWith('Session not found:');
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
