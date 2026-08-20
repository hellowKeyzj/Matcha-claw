import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleCapabilityRoutes } from '../../electron/api/routes/capabilities';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'matcha-agent',
  runtimeInstanceId: 'local',
} as const;
const request = {
  id: 'session.management',
  operationId: 'sessions.list',
  scope: { kind: 'runtime-instance', endpoint },
  target: { kind: 'runtime-endpoint' },
  input: { endpoint },
} as const;
const unavailable = {
  success: false,
  error: 'Matcha session catalog is unavailable',
};

function createRequest(body: unknown) {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: { 'content-length': '1' },
  });
}

function createResponse() {
  const response = { statusCode: 200, body: undefined as unknown };
  return {
    response,
    raw: {
      get statusCode() { return response.statusCode; },
      set statusCode(value: number) { response.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { response.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

describe('Matcha session catalog Host API route', () => {
  it('dispatches the exact Matcha catalog request only to its dedicated transport', async () => {
    const response = createResponse();
    const matchaList = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        sessions: [{
          key: 'matcha-agent:matcha:native-session-1',
          agentId: 'matcha',
          sessionIdentity: {
            endpoint,
            agentId: 'matcha',
            sessionKey: 'matcha-agent:matcha:native-session-1',
          },
          kind: 'named',
          preferred: false,
          endpointSessionId: 'native-session-1',
          protocolId: 'matcha-agent-app-server',
          runtimeEndpointId: 'matcha-agent-local',
        }],
      },
    });
    const openClawList = vi.fn();

    await expect(handleCapabilityRoutes(
      createRequest(request) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: { list: openClawList },
        matchaSessionListTransport: { list: matchaList },
      } as never,
    )).resolves.toBe(true);

    expect(matchaList).toHaveBeenCalledWith(request);
    expect(openClawList).not.toHaveBeenCalled();
    expect(response.response).toEqual({
      statusCode: 200,
      body: {
        sessions: [{
          key: 'matcha-agent:matcha:native-session-1',
          agentId: 'matcha',
          sessionIdentity: {
            endpoint,
            agentId: 'matcha',
            sessionKey: 'matcha-agent:matcha:native-session-1',
          },
          kind: 'named',
          preferred: false,
          endpointSessionId: 'native-session-1',
          protocolId: 'matcha-agent-app-server',
          runtimeEndpointId: 'matcha-agent-local',
        }],
      },
    });
  });

  it.each([
    { ...request, target: { kind: 'runtime-endpoint', endpoint } },
    { ...request, input: { endpoint: { ...endpoint, runtimeInstanceId: 'remote' } } },
  ])('keeps malformed Matcha-shaped requests out of the OpenClaw transport', async (invalidRequest) => {
    const response = createResponse();
    const matchaList = vi.fn().mockResolvedValue({ status: 503, body: unavailable });
    const openClawList = vi.fn();

    await handleCapabilityRoutes(
      createRequest(invalidRequest) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: { list: openClawList },
        matchaSessionListTransport: { list: matchaList },
      } as never,
    );

    expect(matchaList).not.toHaveBeenCalled();
    expect(openClawList).not.toHaveBeenCalled();
    expect(response.response).toEqual({
      statusCode: 500,
      body: { success: false, error: 'Capability request failed' },
    });
  });
});
