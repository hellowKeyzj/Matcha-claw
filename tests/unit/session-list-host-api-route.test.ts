import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../electron/main/ipc/dialog-attachment-staging', () => ({
  consumeStagedAttachment: (...args: unknown[]) => consumeStagedAttachmentMock(...args),
  stageWorkspaceMediaAttachment: vi.fn(),
}));

const consumeStagedAttachmentMock = vi.hoisted(() => vi.fn());

import { handleCapabilityRoutes } from '../../electron/api/routes/capabilities';

const openClawEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const matchaEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'matcha-agent',
  runtimeInstanceId: 'local',
} as const;

const openClawIdentity = {
  endpoint: openClawEndpoint,
  agentId: 'main',
  sessionKey: 'agent:main:main',
} as const;

function createRequest(body: unknown) {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

function createResponse() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

function sessionListRequest(endpoint = openClawEndpoint) {
  return {
    id: 'session.management',
    operationId: 'sessions.list',
    scope: { kind: 'runtime-instance', endpoint },
    target: { kind: 'runtime-endpoint' },
    input: { endpoint },
  };
}

function publicPromptRequest(
  input: Record<string, unknown> = {},
  operationId: 'sessions.prompt' | 'sessions.sendWithMedia' = 'sessions.prompt',
  identity = openClawIdentity,
) {
  return {
    id: 'session.prompt',
    operationId,
    scope: { kind: 'session', identity },
    target: { kind: 'session', identity },
    input: {
      sessionKey: identity.sessionKey,
      sessionIdentity: identity,
      message: 'Hello',
      runId: 'run-1',
      ...input,
    },
  };
}

describe('session Host API public delivery route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the OpenClaw public session catalog to its exact lower request', async () => {
    const response = createResponse();
    const sessionIdentity = {
      endpoint: openClawEndpoint,
      agentId: 'alpha',
      sessionKey: 'agent:alpha:session-1',
    };
    const list = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        sessions: [{
          key: 'agent:alpha:session-1',
          agentId: 'alpha',
          sessionIdentity,
          kind: 'session',
          endpointSessionId: 'session-1',
          updatedAt: 1,
        }],
      },
    });
    const request = sessionListRequest();

    await expect(handleCapabilityRoutes(
      createRequest(request) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionListTransport: { list } } } as never,
    )).resolves.toBe(true);

    expect(list).toHaveBeenCalledWith(request);
    expect(response.state).toEqual({
      statusCode: 200,
      body: {
        sessions: [{
          key: 'agent:alpha:session-1',
          agentId: 'alpha',
          sessionIdentity,
          kind: 'session',
          endpointSessionId: 'session-1',
          updatedAt: 1,
        }],
      },
    });
  });

  it('selects the dedicated Matcha catalog transport by endpoint', async () => {
    const response = createResponse();
    const request = sessionListRequest(matchaEndpoint);
    const matchaList = vi.fn().mockResolvedValue({
      status: 200,
      body: { sessions: [{ endpoint: matchaEndpoint, nativeSessionHandle: 'native-session-1' }] },
    });
    const openClawList = vi.fn();

    await expect(handleCapabilityRoutes(
      createRequest(request) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        runtimeHostTransports: {
          sessionListTransport: { list: openClawList },
          matchaSessionListTransport: { list: matchaList },
        },
      } as never,
    )).resolves.toBe(true);

    expect(matchaList).toHaveBeenCalledWith(request);
    expect(openClawList).not.toHaveBeenCalled();
    expect(response.state).toEqual({
      statusCode: 200,
      body: { sessions: [{ endpoint: matchaEndpoint, nativeSessionHandle: 'native-session-1' }] },
    });
  });

  it('maps the public prompt to lower session.send and preserves the queued route', async () => {
    const response = createResponse();
    const send = vi.fn().mockResolvedValue({
      status: 202,
      body: { outcome: 'queued', runId: 'run-1', routeKey: 'renderer-route:issued' },
    });
    const rendererEventRoutes = {
      issue: vi.fn(() => 'renderer-route:issued'),
      isMatchaRoute: vi.fn(() => false),
      release: vi.fn(),
    };

    await expect(handleCapabilityRoutes(
      createRequest(publicPromptRequest()) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionSendTransport: { send } }, rendererEventRoutes } as never,
    )).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith({
      id: 'session.prompt',
      operationId: 'sessions.send',
      scope: {
        kind: 'session',
        endpoint: openClawEndpoint,
        sessionKey: 'agent:main:main',
        routeKey: 'renderer-route:issued',
      },
      target: { kind: 'session' },
      input: {
        endpoint: openClawEndpoint,
        sessionKey: 'agent:main:main',
        message: 'Hello',
        runId: 'run-1',
        attachments: [],
      },
    }, null);
    expect(rendererEventRoutes.release).not.toHaveBeenCalled();
    expect(response.state).toEqual({
      statusCode: 202,
      body: { outcome: 'queued', runId: 'run-1', routeKey: 'renderer-route:issued' },
    });
  });

  it('rejects public prompt modelSelectionId without calling the lower send transport', async () => {
    const response = createResponse();
    const send = vi.fn();
    const rendererEventRoutes = {
      issue: vi.fn(() => 'renderer-route:should-not-issue'),
      isMatchaRoute: vi.fn(() => false),
      release: vi.fn(),
    };

    await handleCapabilityRoutes(
      createRequest(publicPromptRequest({ modelSelectionId: 'openai/gpt-5.4' })) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionSendTransport: { send } }, rendererEventRoutes } as never,
    );

    expect(send).not.toHaveBeenCalled();
    expect(rendererEventRoutes.issue).not.toHaveBeenCalled();
    expect(response.state).toEqual({
      statusCode: 500,
      body: { success: false, error: 'Capability request failed' },
    });
  });

  it('projects staged media into lower base64 attachments', async () => {
    const response = createResponse();
    const send = vi.fn().mockResolvedValue({
      status: 202,
      body: { outcome: 'queued', runId: 'run-media-1', routeKey: 'renderer-route:issued' },
    });
    consumeStagedAttachmentMock.mockResolvedValueOnce(Buffer.from('hello'));
    const rendererEventRoutes = {
      issue: vi.fn(() => 'renderer-route:issued'),
      isMatchaRoute: vi.fn(() => false),
      release: vi.fn(),
    };

    await expect(handleCapabilityRoutes(
      createRequest(publicPromptRequest({
        runId: 'run-media-1',
        attachments: [{
          stagedAttachmentId: 'attachment-1',
          mimeType: 'image/png',
          fileName: 'image.png',
          fileSize: 5,
        }],
      }, 'sessions.sendWithMedia')) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionSendTransport: { send } }, rendererEventRoutes } as never,
    )).resolves.toBe(true);

    expect(consumeStagedAttachmentMock).toHaveBeenCalledWith('attachment-1');
    expect(send).toHaveBeenCalledWith({
      id: 'session.prompt',
      operationId: 'sessions.send',
      scope: {
        kind: 'session',
        endpoint: openClawEndpoint,
        sessionKey: 'agent:main:main',
        routeKey: 'renderer-route:issued',
      },
      target: { kind: 'session' },
      input: {
        endpoint: openClawEndpoint,
        sessionKey: 'agent:main:main',
        message: 'Hello',
        runId: 'run-media-1',
        attachments: [{ mimeType: 'image/png', fileName: 'image.png', content: 'aGVsbG8=' }],
      },
    }, null);
    expect(response.state).toEqual({
      statusCode: 202,
      body: { outcome: 'queued', runId: 'run-media-1', routeKey: 'renderer-route:issued' },
    });
  });

  it('rejects path-shaped media without calling the lower send transport', async () => {
    const response = createResponse();
    const send = vi.fn();
    const rendererEventRoutes = {
      issue: vi.fn(() => 'renderer-route:should-not-issue'),
      isMatchaRoute: vi.fn(() => false),
      release: vi.fn(),
    };

    await handleCapabilityRoutes(
      createRequest(publicPromptRequest({
        media: { filePath: 'C:\\private\\image.png' },
        attachments: [{
          stagedAttachmentId: 'attachment-1',
          mimeType: 'image/png',
          fileName: 'image.png',
          fileSize: 5,
        }],
      }, 'sessions.sendWithMedia')) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionSendTransport: { send } }, rendererEventRoutes } as never,
    );

    expect(send).not.toHaveBeenCalled();
    expect(rendererEventRoutes.issue).not.toHaveBeenCalled();
    expect(consumeStagedAttachmentMock).not.toHaveBeenCalled();
    expect(response.state).toEqual({
      statusCode: 500,
      body: { success: false, error: 'Capability request failed' },
    });
  });

  it('redacts an invalid lower response and releases its renderer route', async () => {
    const response = createResponse();
    const send = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'succeeded', private: 'Authorization: Bearer private-token' },
    });
    const rendererEventRoutes = {
      issue: vi.fn(() => 'renderer-route:invalid'),
      isMatchaRoute: vi.fn(() => false),
      release: vi.fn(),
    };

    await handleCapabilityRoutes(
      createRequest(publicPromptRequest({ runId: 'run-invalid' })) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionSendTransport: { send } }, rendererEventRoutes } as never,
    );

    expect(rendererEventRoutes.release).toHaveBeenCalledWith('renderer-route:invalid');
    expect(response.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Session send is unavailable' },
    });
    expect(JSON.stringify(response.state)).not.toContain('private-token');
  });

  it('releases its renderer route when the lower transport throws', async () => {
    const response = createResponse();
    const send = vi.fn().mockRejectedValue(new Error('private native path'));
    const rendererEventRoutes = {
      issue: vi.fn(() => 'renderer-route:failed'),
      isMatchaRoute: vi.fn(() => false),
      release: vi.fn(),
    };

    await handleCapabilityRoutes(
      createRequest(publicPromptRequest({ runId: 'run-failed' })) as never,
      response.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionSendTransport: { send } }, rendererEventRoutes } as never,
    );

    expect(rendererEventRoutes.release).toHaveBeenCalledWith('renderer-route:failed');
    expect(response.state).toEqual({
      statusCode: 500,
      body: { success: false, error: 'Capability request failed' },
    });
    expect(JSON.stringify(response.state)).not.toContain('private native path');
  });
});
