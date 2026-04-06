import type { OpenClawBridge } from '../../openclaw-bridge';
import {
  normalizeSendWithMediaInput,
  sendWithMediaViaOpenClawBridge,
} from '../chat/send-media';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface GatewayServiceDeps {
  readonly openclawBridge: Pick<OpenClawBridge, 'chatSend' | 'gatewayRpc'>;
}

export class GatewayService {
  constructor(private readonly deps: GatewayServiceDeps) {}

  async rpc(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const rpcMethod = typeof body.method === 'string' ? body.method.trim() : '';
    if (!rpcMethod) {
      return {
        status: 400,
        data: { success: false, error: 'method is required' },
      };
    }
    try {
      const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0
        ? body.timeoutMs
        : undefined;
      const result = await this.deps.openclawBridge.gatewayRpc(
        rpcMethod,
        body.params,
        timeoutMs,
      );
      return {
        status: 200,
        data: { success: true, result },
      };
    } catch (error) {
      return {
        status: 200,
        data: { success: false, error: String(error) },
      };
    }
  }

  async sendMedia(payload: unknown) {
    const input = normalizeSendWithMediaInput(payload);
    if (!input) {
      return {
        status: 400,
        data: { success: false, error: 'Invalid send-with-media payload' },
      };
    }
    const result = await sendWithMediaViaOpenClawBridge(this.deps.openclawBridge, input);
    if (!result.success) {
      return {
        status: 500,
        data: { success: false, error: result.error ?? 'Send-with-media failed' },
      };
    }
    return {
      status: 200,
      data: { success: true, result: result.result },
    };
  }
}
