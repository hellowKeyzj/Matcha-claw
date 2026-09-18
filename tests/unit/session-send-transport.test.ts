import { describe, expect, it, vi } from 'vitest';
import { createSessionSendTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/send';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const request = {
  id: 'session.prompt',
  operationId: 'sessions.send',
  scope: {
    kind: 'session',
    endpoint,
    sessionKey: 'agent:main:demo',
    routeKey: 'renderer-route:test',
  },
  target: { kind: 'session' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    message: 'describe this',
    runId: 'run-1',
    attachments: [{ mimeType: 'application/pdf', fileName: 'review.pdf', content: 'aGVsbG8=' }],
  },
} as const;

const runtimeHostTransportPort = 34_101;

describe('Electron Main session-send transport', () => {
  it('preserves the OpenClaw local queue admission without claiming peer delivery', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({ outcome: 'queued', runId: 'run-1' }),
    });
    const transport = createSessionSendTransport({ verificationKey: 'public', signDecision }, runtimeHostTransportPort, fetcher);

    await expect(transport.send(request)).resolves.toEqual({
      status: 202,
      body: { outcome: 'queued', runId: 'run-1' },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/sessions/send',
      scope: 'sessions:write',
      capability: 'session.prompt',
      subject: 'session-send',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34101/api/sessions/send', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify(request),
    }));
  });

  it('preserves the OpenClaw canonical runId on success', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: 'succeeded', runId: 'run-1', status: 'started' }),
    });
    const transport = createSessionSendTransport({ verificationKey: 'public', signDecision }, runtimeHostTransportPort, fetcher);

    await expect(transport.send(request)).resolves.toEqual({
      status: 200,
      body: { outcome: 'succeeded', runId: 'run-1', status: 'started' },
    });
  });

  it('admits text through the same OpenClaw serial delivery mailbox', async () => {
    const textRequest = { ...request, input: { ...request.input, attachments: [] } };
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({ outcome: 'queued', runId: 'run-1' }),
    });
    const transport = createSessionSendTransport({ verificationKey: 'public', signDecision }, runtimeHostTransportPort, fetcher);

    await expect(transport.send(textRequest)).resolves.toEqual({
      status: 202,
      body: { outcome: 'queued', runId: 'run-1' },
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34101/api/sessions/send', expect.objectContaining({
      body: JSON.stringify(textRequest),
    }));
  });

  it('signs a generic Matcha attachment request for the local Matcha runtime', async () => {
    const matchaEndpoint = { ...endpoint, runtimeAdapterId: 'matcha-agent' as const };
    const matchaRequest = {
      ...request,
      scope: { ...request.scope, endpoint: matchaEndpoint, sessionKey: 'matcha-session-1' },
      input: {
        ...request.input,
        endpoint: matchaEndpoint,
        sessionKey: 'matcha-session-1',
        attachments: [{ mimeType: 'image/gif' as const, fileName: 'image.gif', content: 'aGVsbG8=' }],
      },
    };
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: 'succeeded', runId: 'run-1', status: 'started' }),
    });
    const transport = createSessionSendTransport({ verificationKey: 'public', signDecision }, runtimeHostTransportPort, fetcher);

    await expect(transport.send(matchaRequest)).resolves.toEqual({
      status: 200,
      body: { outcome: 'succeeded', runId: 'run-1', status: 'started' },
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34101/api/sessions/send', expect.objectContaining({
      body: JSON.stringify(matchaRequest),
    }));
  });

  it.each([
    { ...request, input: { ...request.input, attachments: [{ ...request.input.attachments[0], filePath: 'C:/private/image.png' }] } },
    { ...request, input: { ...request.input, attachments: Array.from({ length: 17 }, () => request.input.attachments[0]) } },
    { ...request, input: { ...request.input, attachments: [{ ...request.input.attachments[0], filePath: 'C:/private/image.png' }] } },
    { ...request, input: { ...request.input, attachments: [{ mimeType: '', fileName: 'review.pdf', content: 'aGVsbG8=' }] } },
    { ...request, scope: { ...request.scope, sessionKey: 'agent:main:other' } },
    {
      ...request,
      scope: { ...request.scope, endpoint: { ...endpoint, runtimeAdapterId: 'matcha-agent' as const } },
      input: {
        ...request.input,
        endpoint: { ...endpoint, runtimeAdapterId: 'matcha-agent' as const },
        attachments: Array.from({ length: 17 }, () => request.input.attachments[0]),
      },
    },
    { ...request, input: { ...request.input, attachments: [{ ...request.input.attachments[0], content: 'aGVsbG8' }] } },
    { ...request, input: { ...request.input, attachments: [{ ...request.input.attachments[0], content: 'aGVsbG9=' }] } },
    { ...request, input: { ...request.input, attachments: [{ ...request.input.attachments[0], content: 'A'.repeat(Math.ceil((20 * 1024 * 1024 + 1) / 3) * 4) }] } },
  ])('fails closed before signing a malformed request', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createSessionSendTransport({ verificationKey: 'public', signDecision }, runtimeHostTransportPort, fetcher);

    await expect(transport.send(invalid)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session send is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('projects the fixed invalid-request response from Rust', async () => {
    const transport = createSessionSendTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 400, json: async () => ({ private: 'native detail' }) }),
    );

    await expect(transport.send(request)).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'Session send request is invalid' },
    });
  });

  it('redacts invalid Rust responses and transport failures', async () => {
    const transport = createSessionSendTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockRejectedValue(new Error('private native path')),
    );

    const response = await transport.send(request);
    expect(response).toEqual({ status: 503, body: { success: false, error: 'Session send is unavailable' } });
    expect(JSON.stringify(response)).not.toContain('private native path');
  });

});
