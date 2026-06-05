import { AcpJsonRpcClient } from './acp-json-rpc-client';
import type {
  RuntimeAbortRequest,
  RuntimePromptRequest,
  RuntimePromptResult,
  RuntimeEndpointProfile,
  RuntimeEndpointReadiness,
  RuntimeResolveApprovalRequest,
  RuntimeSessionTransport,
} from '../../contracts/runtime-endpoint-types';

export class AcpStdioTransport implements RuntimeSessionTransport {
  private readonly client: AcpJsonRpcClient;

  constructor(private readonly endpoint: RuntimeEndpointProfile) {
    if (!endpoint.launcher) {
      throw new Error(`ACP endpoint has no launcher: ${endpoint.id}`);
    }
    this.client = new AcpJsonRpcClient({
      endpointId: endpoint.id,
      launcher: endpoint.launcher,
    });
  }

  async sendPrompt(input: RuntimePromptRequest): Promise<RuntimePromptResult> {
    try {
      const payload = await this.client.request('session/prompt', {
        sessionId: input.context.endpointSessionId ?? input.context.sessionKey,
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
      sessionId: input.context.endpointSessionId ?? input.context.sessionKey,
      approvalIds: input.approvalIds ?? [],
    }, 5_000);
  }

  async resolveApproval(input: RuntimeResolveApprovalRequest): Promise<unknown> {
    return await this.client.request('approval/resolve', {
      sessionId: input.context.endpointSessionId ?? input.context.sessionKey,
      id: input.id,
      decision: input.decision,
    });
  }

  async inspectReadiness(): Promise<RuntimeEndpointReadiness> {
    try {
      const result = await this.client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      }, 5_000);
      return {
        ready: true,
        phase: 'ready',
        details: {
          initialize: result,
          transportEpoch: this.client.transportEpoch,
          stderrTail: this.client.getStderrTail(),
        },
      };
    } catch (error) {
      return {
        ready: false,
        phase: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
        details: {
          transportEpoch: this.client.transportEpoch,
          stderrTail: this.client.getStderrTail(),
        },
      };
    }
  }

  stop(): void {
    this.client.stop();
  }
}
