import { describe, expect, it, vi } from 'vitest';
import { createSessionEventsTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/events';
import { sessionDelta } from './helpers/session-fixtures';

const runtimeHostTransportPort = 19_420;

const delta = sessionDelta('agent:test:main', {
  seq: 1,
  cursor: 1,
  changes: [{ kind: 'recoveryRequired', reason: 'event_overflow' }],
});

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status });
}

function pendingResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
}

async function drain(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe('SessionEventsTransport', () => {
  it('opens the fixed authenticated SSE stream and emits only valid session.delta events', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const onDelta = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(streamResponse([
      ': keepalive\n\n',
      'event: other\n',
      `data: ${JSON.stringify(delta)}\n\n`,
      'event: session.delta\r\n',
      'data: {"sessionKey":"agent:test:main",\r\n',
      'data: "epoch":1,"seq":2,"cursor":2,\r\n',
      'data: "changes":[{"kind":"recoveryRequired","reason":"cursor_gap"}]}\r\n\r\n',
      'event: session.delta\n',
      'data: {"bad":true}\n\n',
    ]));

    const transport = createSessionEventsTransport({ verificationKey: 'public', signDecision }, runtimeHostTransportPort, fetcher);
    transport.onDelta(onDelta);
    await drain();
    transport.close();

    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/sessions/events',
      scope: 'session:events:read',
      capability: 'session.events',
      subject: 'session-events',
      principal: 'electron-main-local',
      revision: '1',
    }));
    const decision = signDecision.mock.calls[0]![0];
    expect(decision.expiresAt).toBeGreaterThanOrEqual(Date.now() + 29_000);
    expect(decision.expiresAt).toBeLessThanOrEqual(Date.now() + 30_500);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:19420/api/sessions/events', expect.objectContaining({
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer signed-decision',
      },
    }));
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith({
      sessionKey: 'agent:test:main',
      epoch: 1,
      seq: 2,
      cursor: 2,
      changes: [{ kind: 'recoveryRequired', reason: 'cursor_gap' }],
    });
  });

  it('keeps incomplete chunk buffers and resumes reconnects with Last-Event-ID', async () => {
    vi.useFakeTimers();
    const onDelta = vi.fn();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(streamResponse([
        'id: 41\n',
        'event: session.delta\n',
        'data: {"sessionKey":"agent:test:main","epoch":1,',
        '"seq":1,"cursor":1,"changes":[{"kind":"recoveryRequired","reason":"event_overflow"}]}\n\n',
      ]))
      .mockResolvedValueOnce(pendingResponse());

    const transport = createSessionEventsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      runtimeHostTransportPort,
      fetcher,
      { reconnectDelayMs: 5 },
    );
    transport.onDelta(onDelta);
    await drain();
    expect(onDelta).toHaveBeenCalledWith(delta);

    await vi.advanceTimersByTimeAsync(5);
    await drain();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![1].headers).toMatchObject({
      'Last-Event-ID': '41',
    });

    transport.close();
    vi.useRealTimers();
  });

  it('stops reconnecting on terminal statuses and close aborts active streams', async () => {
    vi.useFakeTimers();
    const terminalFetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const terminalTransport = createSessionEventsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      runtimeHostTransportPort,
      terminalFetcher,
      { reconnectDelayMs: 5 },
    );
    terminalTransport.onDelta(vi.fn());
    await drain();
    await vi.advanceTimersByTimeAsync(20);
    expect(terminalFetcher).toHaveBeenCalledTimes(1);

    const activeFetcher = vi.fn().mockResolvedValue(pendingResponse());
    const transport = createSessionEventsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      runtimeHostTransportPort,
      activeFetcher,
      { reconnectDelayMs: 5 },
    );
    transport.onDelta(vi.fn());
    await drain();
    const signal = activeFetcher.mock.calls[0]![1].signal as AbortSignal;
    transport.close();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(activeFetcher).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
