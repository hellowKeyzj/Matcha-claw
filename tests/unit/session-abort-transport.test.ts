import { describe, expect, it, vi } from 'vitest';
import { createSessionAbortTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/abort';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const request = {
  id: 'session.abort',
  operationId: 'sessions.abort',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'session' },
  input: { endpoint, sessionKey: 'agent:main:demo', runId: 'run-1' },
} as const;

const runtimeHostTransportPort = 34_101;

describe('Electron Main session-abort transport', () => {
  it('signs only the fixed local abort request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: 'succeeded' }),
    });
    const transport = createSessionAbortTransport({ verificationKey: 'public', signDecision }, runtimeHostTransportPort, fetcher);

    await expect(transport.abort(request)).resolves.toEqual({
      status: 200,
      body: { outcome: 'succeeded' },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/sessions/abort',
      scope: 'sessions:write',
      capability: 'sessions.abort',
      subject: 'session-abort',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34101/api/sessions/abort', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify(request),
    }));
  });

  it.each([
    { ...request, input: { ...request.input, sessionKey: 'agent:main:other' } },
    { ...request, scope: { ...request.scope, endpoint: { ...endpoint, runtimeAdapterId: 'matcha-agent' as const } } },
    { ...request, input: { ...request.input, runId: '' } },
  ])('maps malformed requests to OutcomeUnknown before signing', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createSessionAbortTransport({ verificationKey: 'public', signDecision }, runtimeHostTransportPort, fetcher);

    await expect(transport.abort(invalid)).resolves.toEqual({
      status: 200,
      body: { outcome: 'unknown' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves approvalIds as a legal compatibility input', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: 'unknown' }),
    });
    const transport = createSessionAbortTransport({ verificationKey: 'public', signDecision }, runtimeHostTransportPort, fetcher);
    const approvalRequest = {
      ...request,
      input: { ...request.input, approvalIds: ['approval-1'] },
    };

    await expect(transport.abort(approvalRequest)).resolves.toEqual({
      status: 200,
      body: { outcome: 'unknown' },
    });
    expect(signDecision).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('maps nonterminal delivery responses and failures to OutcomeUnknown', async () => {
    const transport = createSessionAbortTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 503, json: async () => ({ private: 'native detail' }) }),
    );

    const response = await transport.abort(request);
    expect(response).toEqual({ status: 200, body: { outcome: 'unknown' } });
    expect(JSON.stringify(response)).not.toContain('native detail');
  });
});
