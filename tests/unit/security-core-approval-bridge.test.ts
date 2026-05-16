import { describe, expect, it } from 'vitest';
import { ApprovalBridgeService } from '../../packages/openclaw-security-plugin/src/infrastructure/approval-bridge';

class FakeWebSocket {
  static last: FakeWebSocket | null = null;

  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.last = this;
    queueMicrotask(() => {
      this.emit('message', JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce-1' },
      }));
    });
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as { id: string; method: string; params?: Record<string, unknown> };
    this.sent.push(frame);
    if (frame.method === 'connect') {
      this.respond(frame.id, {});
      return;
    }
    if (frame.method === 'exec.approval.request') {
      this.respond(frame.id, { id: frame.params?.id });
      return;
    }
    if (frame.method === 'exec.approval.waitDecision') {
      this.respond(frame.id, {
        id: frame.params?.id,
        decision: 'allow-once',
      });
    }
  }

  close(): void {
    // no-op
  }

  private respond(id: string, payload: unknown): void {
    queueMicrotask(() => {
      this.emit('message', JSON.stringify({
        type: 'res',
        id,
        ok: true,
        payload,
      }));
    });
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

describe('security-core approval bridge', () => {
  it('treats Gateway allow-once as an approved native decision', async () => {
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const service = new ApprovalBridgeService({
        loadConfig: async () => ({
          gateway: {
            port: 18789,
            token: 'token-1',
          },
        }),
      });

      const result = await service.requestNativeApproval({
        toolName: 'exec',
        toolParams: { command: 'Remove-Item demo.txt' },
        sessionKey: 'agent:main:main',
        requestTimeoutMs: 100,
        decisionTimeoutMs: 100,
      });

      expect(result).toMatchObject({
        status: 'approved',
        decision: 'allow-once',
      });
    } finally {
      globalThis.WebSocket = previousWebSocket;
      FakeWebSocket.last = null;
    }
  });
});
