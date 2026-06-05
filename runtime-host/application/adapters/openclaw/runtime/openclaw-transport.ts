import type { GatewayChatPort, GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import type {
  RuntimeAbortRequest,
  RuntimePatchModelRequest,
  RuntimePatchModelResult,
  RuntimePromptRequest,
  RuntimePromptResult,
  RuntimeResolveApprovalRequest,
  RuntimeSessionTransport,
} from '../../../agent-runtime/contracts/runtime-endpoint-types';

function resolveApprovalMethod(id: string): 'exec.approval.resolve' | 'plugin.approval.resolve' {
  return id.startsWith('plugin:') ? 'plugin.approval.resolve' : 'exec.approval.resolve';
}

export class OpenClawRuntimeTransport implements RuntimeSessionTransport {
  constructor(private readonly gateway: GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'>) {}

  async sendPrompt(input: RuntimePromptRequest): Promise<RuntimePromptResult> {
    try {
      const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
        ? input.payload as Record<string, unknown>
        : {};
      const result = await this.gateway.chatSend({
        ...payload,
        sessionKey: input.context.endpointSessionId ?? input.context.sessionKey,
        message: input.message,
        idempotencyKey: input.runId,
      });
      const record = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null;
      const success = record?.success !== false;
      return {
        success,
        ...(typeof record?.error === 'string' ? { error: record.error } : {}),
        payload: result,
      };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  async abortSession(input: RuntimeAbortRequest): Promise<void> {
    await Promise.all((input.approvalIds ?? []).map((id) => this.gateway.gatewayRpc(resolveApprovalMethod(id), {
      id,
      decision: 'deny',
    }, 5000).catch(() => undefined)));
    await this.gateway.gatewayRpc('chat.abort', { sessionKey: input.context.endpointSessionId ?? input.context.sessionKey }, 5000);
  }

  async resolveApproval(input: RuntimeResolveApprovalRequest): Promise<unknown> {
    return await this.gateway.gatewayRpc(resolveApprovalMethod(input.id), {
      id: input.id,
      decision: input.decision,
    });
  }

  async patchSessionModel(input: RuntimePatchModelRequest): Promise<RuntimePatchModelResult> {
    const payload = await this.gateway.gatewayRpc('sessions.patch', {
      key: input.context.endpointSessionId ?? input.context.sessionKey,
      model: input.runtimeModelRef,
    }, 10000);
    return {
      runtimeModelRef: input.runtimeModelRef,
      payload,
    };
  }
}
