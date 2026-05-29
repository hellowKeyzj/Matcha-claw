import { AcpJsonRpcClient } from './acp-json-rpc-client';
import type {
  RuntimeAbortRequest,
  RuntimePromptRequest,
  RuntimePromptResult,
  RuntimeProviderProfile,
  RuntimeProviderReadiness,
  RuntimeResolveApprovalRequest,
  RuntimeSessionTransport,
} from '../runtime-provider-types';

export class AcpStdioTransport implements RuntimeSessionTransport {
  private readonly client: AcpJsonRpcClient;

  constructor(private readonly profile: RuntimeProviderProfile) {
    if (!profile.launcher) {
      throw new Error(`Runtime provider has no ACP launcher: ${profile.id}`);
    }
    this.client = new AcpJsonRpcClient({
      runtimeProviderId: profile.id,
      launcher: profile.launcher,
    });
  }

  async sendPrompt(input: RuntimePromptRequest): Promise<RuntimePromptResult> {
    try {
      const payload = await this.client.request('session/prompt', {
        sessionId: input.context.providerSessionId ?? input.context.sessionKey,
        runId: input.runId,
        message: input.message,
        payload: input.payload,
      });
      return { success: true, payload };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async abortSession(input: RuntimeAbortRequest): Promise<void> {
    await this.client.request('session/cancel', {
      sessionId: input.context.providerSessionId ?? input.context.sessionKey,
      approvalIds: input.approvalIds ?? [],
    }, 5_000);
  }

  async resolveApproval(input: RuntimeResolveApprovalRequest): Promise<unknown> {
    return await this.client.request('approval/resolve', {
      sessionId: input.context.providerSessionId ?? input.context.sessionKey,
      id: input.id,
      decision: input.decision,
    });
  }

  async inspectReadiness(): Promise<RuntimeProviderReadiness> {
    return {
      ready: true,
      phase: 'ready',
      details: {
        transportEpoch: this.client.transportEpoch,
        stderrTail: this.client.getStderrTail(),
      },
    };
  }
}
