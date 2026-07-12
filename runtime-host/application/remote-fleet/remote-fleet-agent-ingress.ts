import {
  normalizeRuntimeAgentClientRequest,
  type RuntimeAgentClientRequest,
  type RuntimeAgentClientResponse,
  type RuntimeAgentRejectedResponse,
  type RuntimeAgentResponseRejectionReason,
  type RuntimeAgentValidationFailureReason,
} from './remote-fleet-agent-client';

export const REMOTE_FLEET_RUNTIME_AGENT_INGRESS_PATH = '/api/remote-fleet/runtime-agent/ingress';

type RuntimeAgentInboundRequest = Extract<
  RuntimeAgentClientRequest,
  | { readonly type: 'runtime-agent.heartbeat' }
  | { readonly type: 'runtime-agent.command.progress' }
  | { readonly type: 'runtime-agent.command.result' }
>;

export type RuntimeAgentIngressInvalidReason = RuntimeAgentValidationFailureReason | 'unsupported-operation';

type RuntimeAgentIngressResponseType =
  | 'runtime-agent.heartbeat.response'
  | 'runtime-agent.command.accept.response'
  | 'runtime-agent.command.progress.response'
  | 'runtime-agent.command.result.response'
  | 'runtime-agent.capabilities.sync.response'
  | 'runtime-agent.runtime.start.response'
  | 'runtime-agent.runtime.stop.response'
  | 'runtime-agent.ingress.response';

export type RuntimeAgentIngressResponse =
  | Extract<
    RuntimeAgentClientResponse,
    | { readonly type: 'runtime-agent.heartbeat.response' }
    | { readonly type: 'runtime-agent.command.progress.response' }
    | { readonly type: 'runtime-agent.command.result.response' }
  >
  | RuntimeAgentRejectedResponse<RuntimeAgentIngressResponseType>;

export type RuntimeAgentIngressResult =
  | {
    readonly resultType: 'valid';
    readonly request: RuntimeAgentInboundRequest;
  }
  | {
    readonly resultType: 'invalid';
    readonly reason: RuntimeAgentIngressInvalidReason;
    readonly field: string;
    readonly message: string;
  };

export function normalizeRuntimeAgentIngressOperation(input: unknown): RuntimeAgentIngressResult {
  const request = normalizeRuntimeAgentClientRequest(input);
  if (request.resultType === 'invalid') {
    return request;
  }

  switch (request.value.type) {
    case 'runtime-agent.heartbeat':
    case 'runtime-agent.command.progress':
    case 'runtime-agent.command.result':
      return { resultType: 'valid', request: request.value };
    case 'runtime-agent.command.accept':
      return invalid(
        'unsupported-operation',
        'type',
        'Runtime agent command accept requests are issued by Remote Fleet and cannot be ingressed from RuntimeAgent.',
      );
    case 'runtime-agent.capabilities.sync':
      return invalid(
        'unsupported-operation',
        'type',
        'Runtime agent capability sync is owned by Remote Fleet and cannot be ingressed from RuntimeAgent.',
      );
    case 'runtime-agent.runtime.start':
    case 'runtime-agent.runtime.stop':
      return invalid(
        'unsupported-operation',
        'type',
        'Runtime agent lifecycle commands are issued by Remote Fleet and cannot be ingressed from RuntimeAgent.',
      );
  }
}

export function createRuntimeAgentIngressRejectedResponse(
  request: unknown,
  reason: RuntimeAgentResponseRejectionReason,
  receivedAt?: string,
): RuntimeAgentRejectedResponse<RuntimeAgentIngressResponseType> {
  const record = readRecord(request);
  const requestId = readResponseField(record, 'requestId') ?? 'invalid-request';
  const agentId = readResponseField(record, 'agentId');
  return {
    type: responseTypeForRequest(record),
    requestId,
    ...(agentId === undefined ? {} : { agentId }),
    resultType: 'rejected',
    reason,
    message: rejectionMessage(reason),
    ...(receivedAt === undefined ? {} : { receivedAt }),
  };
}

function responseTypeForRequest(record: Record<string, unknown>): RuntimeAgentIngressResponseType {
  switch (record.type) {
    case 'runtime-agent.heartbeat':
      return 'runtime-agent.heartbeat.response';
    case 'runtime-agent.command.accept':
      return 'runtime-agent.command.accept.response';
    case 'runtime-agent.command.progress':
      return 'runtime-agent.command.progress.response';
    case 'runtime-agent.command.result':
      return 'runtime-agent.command.result.response';
    case 'runtime-agent.capabilities.sync':
      return 'runtime-agent.capabilities.sync.response';
    case 'runtime-agent.runtime.start':
      return 'runtime-agent.runtime.start.response';
    case 'runtime-agent.runtime.stop':
      return 'runtime-agent.runtime.stop.response';
    default:
      return 'runtime-agent.ingress.response';
  }
}

function rejectionMessage(reason: RuntimeAgentResponseRejectionReason): string {
  switch (reason) {
    case 'invalid-request':
      return 'RuntimeAgent ingress request is invalid.';
    case 'unauthorized':
      return 'RuntimeAgent ingress credential is invalid or expired.';
    case 'unsupported-operation':
      return 'RuntimeAgent ingress operation is not supported.';
    case 'runtime-unavailable':
      return 'RuntimeAgent ingress is temporarily unavailable.';
    case 'command-conflict':
      return 'RuntimeAgent command acknowledgement conflicts with canonical command state.';
    case 'rate-limited':
      return 'RuntimeAgent ingress is rate limited.';
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readResponseField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function invalid(
  reason: RuntimeAgentIngressInvalidReason,
  field: string,
  message: string,
): RuntimeAgentIngressResult {
  return { resultType: 'invalid', reason, field, message };
}
