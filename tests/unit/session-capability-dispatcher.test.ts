import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../electron/main/ipc/dialog-attachment-staging', () => ({
  consumeStagedAttachment: vi.fn(),
  releaseStagedAttachments: vi.fn(),
  stageWorkspaceMediaAttachment: vi.fn(),
}));

import { dispatchSessionCapability } from '../../electron/api/routes/sessions';
import { stageWorkspaceMediaAttachment } from '../../electron/main/ipc/dialog-attachment-staging';

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

function sessionSendRequest(endpoint = openClawEndpoint) {
  const isOpenClaw = endpoint.runtimeAdapterId === 'openclaw';
  const sessionKey = isOpenClaw ? 'agent:main:main' : 'matcha-session-1';
  const agentId = isOpenClaw ? 'main' : 'default';
  return {
    id: 'session.prompt',
    operationId: 'sessions.prompt',
    scope: {
      kind: 'session',
      identity: { endpoint, agentId, sessionKey },
    },
    target: {
      kind: 'session',
      identity: { endpoint, agentId, sessionKey },
    },
    input: {
      sessionKey,
      sessionIdentity: { endpoint, agentId, sessionKey },
      message: 'Hello',
      runId: 'run-1',
      attachments: [],
    },
  };
}

function workspaceMediaRequest(operationId: string, input: Record<string, unknown>) {
  return {
    id: 'workspace.media',
    operationId,
    scope: { kind: 'session', endpoint: openClawEndpoint, sessionKey: 'agent:main:main' },
    target: { kind: 'workspace-media' },
    input: {
      endpoint: openClawEndpoint,
      sessionKey: 'agent:main:main',
      ...input,
    },
  };
}

function sessionContentRequest() {
  const identity = { endpoint: openClawEndpoint, agentId: 'main', sessionKey: 'agent:main:main' };
  return {
    id: 'session.management',
    operationId: 'sessions.content.load',
    scope: { kind: 'session', identity },
    target: { kind: 'session', identity },
    input: {
      sessionKey: identity.sessionKey,
      endpointSessionId: 'main',
      sessionIdentity: identity,
      contentRef: 'content-ref-1',
      offset: 7,
      limit: 65536,
    },
  };
}

function workspaceDeps(execute: ReturnType<typeof vi.fn>) {
  return {
    deps: {
      runtimeHostTransports: {
        workspaceMediaTransport: { execute },
      },
    } as never,
  };
}

function routeDeps(send: ReturnType<typeof vi.fn>, isMatchaRoute = false) {
  const rendererEventRoutes = {
    issue: vi.fn(() => 'renderer-route:issued'),
    isMatchaRoute: vi.fn(() => isMatchaRoute),
    release: vi.fn(),
  };
  return {
    deps: {
      runtimeHostTransports: {
        sessionSendTransport: { send },
      },
      rendererEventRoutes,
    } as never,
    rendererEventRoutes,
  };
}

describe('session capability dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects prepare through resolve into an opaque staged attachment', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: {
        reference: 'media_0123456789abcdef0123456789abcdef',
        name: 'image.png',
        mimeType: 'image/png',
        size: 5,
        preview: 'preview',
      } })
      .mockResolvedValueOnce({ status: 200, body: { data: 'aGVsbG8=' } });
    vi.mocked(stageWorkspaceMediaAttachment).mockResolvedValue({
      stagedAttachmentId: 'staged-1',
      fileName: 'image.png',
      mimeType: 'image/png',
      fileSize: 5,
      preview: 'preview',
    });

    const response = await dispatchSessionCapability(workspaceMediaRequest('media.prepare', {
      relativePath: 'docs/image.png',
      mimeType: 'image/png',
    }), workspaceDeps(execute).deps);

    expect(response).toEqual({ status: 200, body: {
      stagedAttachmentId: 'staged-1',
      fileName: 'image.png',
      mimeType: 'image/png',
      fileSize: 5,
      preview: 'preview',
    } });
    expect(JSON.stringify(response)).not.toContain('media_');
    expect(JSON.stringify(response)).not.toContain('data');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('projects thumbnails to the original key map and isolates missing entries', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: {
      'docs/ok.png': { preview: 'preview', fileSize: 5 },
    } });
    const response = await dispatchSessionCapability(workspaceMediaRequest('media.thumbnails', {
      paths: [
        { key: 'docs/ok.png', relativePath: 'docs/ok.png', mimeType: 'image/png' },
        { key: 'docs/missing.png', relativePath: 'docs/missing.png', mimeType: 'image/png' },
      ],
    }), workspaceDeps(execute).deps);

    expect(response).toEqual({ status: 200, body: {
      'docs/ok.png': { preview: 'preview', fileSize: 5 },
      'docs/missing.png': { preview: null, fileSize: 0 },
    } });
  });

  it('accepts full outgoing Gateway SVG thumbnail requests', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: {
      preview: 'data:image/svg+xml;base64,PHN2Zw==',
      fileSize: 6,
    } });
    const input = {
      gatewayUrl: 'https://gateway.local/api/chat/media/outgoing/agent%3Amain%3Amain/attachment-1/full',
      mimeType: 'image/svg+xml',
      agentId: 'main',
    };

    const response = await dispatchSessionCapability(workspaceMediaRequest('media.thumbnail', input), workspaceDeps(execute).deps);

    expect(response).toEqual({ status: 200, body: {
      preview: 'data:image/svg+xml;base64,PHN2Zw==',
      fileSize: 6,
    } });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining(input) }));
  });

  it('keeps stagePaths and stageBuffer public results opaque', async () => {
    const receipt = {
      reference: 'media_0123456789abcdef0123456789abcdef',
      name: 'image.png',
      mimeType: 'image/png',
      size: 5,
      preview: null,
    };
    vi.mocked(stageWorkspaceMediaAttachment).mockResolvedValue({
      stagedAttachmentId: 'staged-1', fileName: 'image.png', mimeType: 'image/png', fileSize: 5, preview: null,
    });
    const pathsExecute = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: [receipt] })
      .mockResolvedValueOnce({ status: 200, body: { data: 'aGVsbG8=' } });
    const pathsResponse = await dispatchSessionCapability(workspaceMediaRequest('media.stagePaths', {
      paths: [{ key: 'docs/image.png', relativePath: 'docs/image.png', mimeType: 'image/png' }],
    }), workspaceDeps(pathsExecute).deps);
    expect(pathsResponse).toEqual({ status: 200, body: [{
      stagedAttachmentId: 'staged-1', fileName: 'image.png', mimeType: 'image/png', fileSize: 5, preview: null,
    }] });

    const bufferExecute = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: receipt })
      .mockResolvedValueOnce({ status: 200, body: { data: 'aGVsbG8=' } });
    const bufferResponse = await dispatchSessionCapability(workspaceMediaRequest('media.stageBuffer', {
      fileName: 'image.png', mimeType: 'image/png', base64: 'aGVsbG8=',
    }), workspaceDeps(bufferExecute).deps);
    expect(bufferResponse).toEqual({ status: 200, body: {
      stagedAttachmentId: 'staged-1', fileName: 'image.png', mimeType: 'image/png', fileSize: 5, preview: null,
    } });
    expect(JSON.stringify(pathsResponse)).not.toMatch(/reference|data|stagedPath|[A-Z]:\\/);
    expect(JSON.stringify(bufferResponse)).not.toMatch(/reference|data|stagedPath|[A-Z]:\\/);
  });

  it('rejects direct resolve and oversized stageBuffer before transport', async () => {
    const execute = vi.fn();
    const directResolve = await dispatchSessionCapability(workspaceMediaRequest('media.resolve', {
      reference: 'media_0123456789abcdef0123456789abcdef',
    }), workspaceDeps(execute).deps);
    const oversized = await dispatchSessionCapability(workspaceMediaRequest('media.stageBuffer', {
      fileName: 'large.bin', mimeType: 'application/octet-stream', base64: 'A'.repeat(28_000_000),
    }), workspaceDeps(execute).deps);
    expect(directResolve).toEqual({ status: 400, body: { success: false, error: 'Workspace media request is invalid' } });
    expect(oversized?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('dispatches session content chunk loads through the content transport', async () => {
    const load = vi.fn().mockResolvedValue({ status: 200, body: {
      contentRef: 'content-ref-1',
      offset: 7,
      text: 'chunk',
      nextOffset: 12,
      totalBytes: 12,
      complete: true,
    } });
    const timelineLoad = vi.fn();
    const window = vi.fn();
    const list = vi.fn();
    const request = sessionContentRequest();

    const response = await dispatchSessionCapability(request, {
      runtimeHostTransports: {
        sessionContentTransport: { load },
        sessionTimelineTransport: { load: timelineLoad, window },
        sessionListTransport: { list },
      },
    } as never);

    expect(response).toEqual({ status: 200, body: {
      contentRef: 'content-ref-1',
      offset: 7,
      text: 'chunk',
      nextOffset: 12,
      totalBytes: 12,
      complete: true,
    } });
    expect(load).toHaveBeenCalledWith(request);
    expect(timelineLoad).not.toHaveBeenCalled();
    expect(window).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it.each(['sessions.load', 'sessions.window'] as const)(
    'preserves Matcha session identity for %s through the canonical timeline transport',
    async (operationId) => {
      const identity = { endpoint: matchaEndpoint, agentId: 'default', sessionKey: 'matcha-session-1' };
      const load = vi.fn().mockResolvedValue({ status: 200, body: { sessionKey: identity.sessionKey } });
      const window = vi.fn().mockResolvedValue({ status: 200, body: { sessionKey: identity.sessionKey } });
      const list = vi.fn();
      const input = operationId === 'sessions.load'
        ? { sessionKey: identity.sessionKey, sessionIdentity: identity, limit: 25 }
        : { sessionKey: identity.sessionKey, sessionIdentity: identity, mode: 'latest', limit: 25 };

      const response = await dispatchSessionCapability({
        id: operationId === 'sessions.load' ? 'session.prompt' : 'session.management',
        operationId,
        scope: { kind: 'session', identity },
        target: { kind: 'session', identity },
        input,
      }, {
        runtimeHostTransports: {
          sessionTimelineTransport: { load, window },
          sessionListTransport: { list },
        },
      } as never);

      expect(response).toEqual({ status: 200, body: { sessionKey: identity.sessionKey } });
      expect(list).not.toHaveBeenCalled();
      expect(operationId === 'sessions.load' ? load : window).toHaveBeenCalledWith({
        id: 'session.management',
        operationId,
        scope: { kind: 'session', identity },
        target: { kind: 'session', identity },
        input,
      });
      expect(operationId === 'sessions.load' ? window : load).not.toHaveBeenCalled();
    },
  );

  it('keeps the OpenClaw renderer route after queue admission', async () => {
    const send = vi.fn().mockResolvedValue({
      status: 202,
      body: {
        outcome: 'queued',
        runId: 'run-1',
        routeKey: 'renderer-route:issued',
      },
    });
    const { deps, rendererEventRoutes } = routeDeps(send);

    await expect(dispatchSessionCapability(sessionSendRequest(), deps)).resolves.toEqual({
      status: 202,
      body: {
        outcome: 'queued',
        runId: 'run-1',
        routeKey: 'renderer-route:issued',
      },
    });
    expect(rendererEventRoutes.release).not.toHaveBeenCalled();
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
    });
  });

  it('keeps the Matcha renderer route after successful admission', async () => {
    const send = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        outcome: 'succeeded',
        runId: 'run-1',
        routeKey: 'renderer-route:issued',
        status: 'started',
      },
    });
    const { deps, rendererEventRoutes } = routeDeps(send, true);

    await expect(dispatchSessionCapability(sessionSendRequest(matchaEndpoint), deps)).resolves.toEqual({
      status: 200,
      body: {
        outcome: 'succeeded',
        runId: 'run-1',
        routeKey: 'renderer-route:issued',
        status: 'started',
      },
    });
    expect(rendererEventRoutes.release).not.toHaveBeenCalled();
  });

  it('keeps OpenClaw route when native ack run differs from request identity', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        status: 202,
        body: { outcome: 'queued', runId: 'native-run-1' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { outcome: 'succeeded', runId: 'native-run-2', status: 'started' },
      });
    const { deps, rendererEventRoutes } = routeDeps(send);

    await expect(dispatchSessionCapability(sessionSendRequest(), deps)).resolves.toEqual({
      status: 202,
      body: { outcome: 'queued', runId: 'native-run-1', routeKey: 'renderer-route:issued' },
    });
    await expect(dispatchSessionCapability(sessionSendRequest(), deps)).resolves.toEqual({
      status: 200,
      body: { outcome: 'succeeded', runId: 'native-run-2', status: 'started' },
    });
    expect(rendererEventRoutes.release).not.toHaveBeenCalled();
  });

  it('keeps terminal send outcomes routed until the session delta closes them', async () => {
    const send = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'unavailable' } });
    const { deps, rendererEventRoutes } = routeDeps(send);

    await expect(dispatchSessionCapability(sessionSendRequest(), deps)).resolves.toEqual({
      status: 200,
      body: { outcome: 'unavailable' },
    });
    expect(rendererEventRoutes.release).not.toHaveBeenCalled();
  });

  it('rejects mismatched Matcha native run receipts', async () => {
    const send = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'succeeded', runId: 'native-run-1', status: 'started' },
    });
    const { deps, rendererEventRoutes } = routeDeps(send, true);

    await expect(dispatchSessionCapability(sessionSendRequest(matchaEndpoint), deps)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session send is unavailable' },
    });
    expect(rendererEventRoutes.release).toHaveBeenCalledWith('renderer-route:issued');
  });

  it.each([
    {
      endpoint: openClawEndpoint,
      body: { outcome: 'succeeded', private: 'Authorization: Bearer private-token' },
      isMatchaRoute: false,
    },
    {
      endpoint: matchaEndpoint,
      body: { outcome: 'succeeded', routeKey: 'renderer-route:issued', status: 'started' },
      isMatchaRoute: true,
    }
  ])('redacts an invalid session send response and releases its route', async ({
    endpoint,
    body,
    isMatchaRoute,
  }) => {
    const send = vi.fn().mockResolvedValue({ status: 200, body });
    const { deps, rendererEventRoutes } = routeDeps(send, isMatchaRoute);

    const response = await dispatchSessionCapability(sessionSendRequest(endpoint), deps);

    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Session send is unavailable' },
    });
    expect(rendererEventRoutes.release).toHaveBeenCalledWith('renderer-route:issued');
    expect(JSON.stringify(response)).not.toContain('private-token');
  });

  it('dispatches session permission get/set with the full SessionIdentity envelope', async () => {
    const identity = { endpoint: openClawEndpoint, agentId: 'main', sessionKey: 'agent:main:main' };
    const getProjection = {
      supported: true,
      mode: 'guarded',
      defaultMode: 'workspace',
      pending: false,
      canSelectFull: true,
      options: ['read-only', 'guarded', 'workspace', 'full'],
    };
    const setProjection = { ...getProjection, mode: 'full' };
    const get = vi.fn().mockResolvedValue({ status: 200, body: getProjection });
    const set = vi.fn().mockResolvedValue({ status: 200, body: setProjection });
    const getRequest = {
      id: 'session.management',
      operationId: 'sessions.permission.get',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: { sessionKey: identity.sessionKey, sessionIdentity: identity },
    };
    const setRequest = {
      ...getRequest,
      operationId: 'sessions.permission.set',
      input: { sessionKey: identity.sessionKey, sessionIdentity: identity, permissionMode: 'full' },
    };

    await expect(dispatchSessionCapability(getRequest, { runtimeHostTransports: { sessionPermissionTransport: { get, set } } } as never)).resolves.toEqual({
      status: 200,
      body: getProjection,
    });
    await expect(dispatchSessionCapability(setRequest, { runtimeHostTransports: { sessionPermissionTransport: { get, set } } } as never)).resolves.toEqual({
      status: 200,
      body: setProjection,
    });

    expect(get).toHaveBeenCalledWith(getRequest);
    expect(set).toHaveBeenCalledWith(setRequest);
  });

  it('rejects session permission requests bound only by the session key', async () => {
    const identity = { endpoint: openClawEndpoint, agentId: 'main', sessionKey: 'agent:main:main' };
    const get = vi.fn();
    const set = vi.fn();

    await expect(dispatchSessionCapability({
      id: 'session.management',
      operationId: 'sessions.permission.set',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: {
        sessionKey: identity.sessionKey,
        sessionIdentity: { ...identity, agentId: 'other' },
        permissionMode: 'full',
      },
    }, { runtimeHostTransports: { sessionPermissionTransport: { get, set } } } as never)).rejects.toThrow('Session permission request is invalid');
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('flattens legacy renderer model selection requests to the native Rust schema', async () => {
    const identity = { endpoint: openClawEndpoint, agentId: 'default', sessionKey: 'agent:default:main' };
    const select = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'succeeded' } });

    const response = await dispatchSessionCapability({
      id: 'session.modelSelection',
      operationId: 'sessions.patchModel',
      scope: { kind: 'session', identity },
      target: { kind: 'model-selection', identity, modelSelectionId: 'anthropic/claude-opus-4-6' },
      input: {
        sessionKey: identity.sessionKey,
        sessionIdentity: identity,
        modelSelectionId: 'anthropic/claude-opus-4-6',
      },
    }, { runtimeHostTransports: { sessionModelSelectionTransport: { select } } } as never);

    expect(response).toEqual({ status: 200, body: { outcome: 'succeeded' } });
    expect(select).toHaveBeenCalledWith({
      id: 'session.modelSelection',
      operationId: 'sessions.patchModel',
      scope: { kind: 'session', endpoint: openClawEndpoint, sessionKey: identity.sessionKey },
      target: { kind: 'model-selection' },
      input: {
        endpoint: openClawEndpoint,
        sessionKey: identity.sessionKey,
        modelSelectionId: 'anthropic/claude-opus-4-6',
      },
    });
  });

  it('accepts OpenClaw agent-scoped model selection requests with optional endpointSessionId', async () => {
    const identity = { endpoint: openClawEndpoint, agentId: 'designer-agent', sessionKey: 'agent:designer-agent:main' };
    const select = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'succeeded' } });

    await expect(dispatchSessionCapability({
      id: 'session.modelSelection',
      operationId: 'sessions.patchModel',
      scope: { kind: 'session', identity },
      target: { kind: 'model-selection', identity, modelSelectionId: 'openai/gpt-5.4' },
      input: {
        sessionKey: identity.sessionKey,
        endpointSessionId: 'main',
        sessionIdentity: identity,
        modelSelectionId: 'openai/gpt-5.4',
      },
    }, { runtimeHostTransports: { sessionModelSelectionTransport: { select } } } as never)).resolves.toEqual({
      status: 200,
      body: { outcome: 'succeeded' },
    });
    expect(select.mock.calls[0]?.[0]).toEqual({
      id: 'session.modelSelection',
      operationId: 'sessions.patchModel',
      scope: { kind: 'session', endpoint: openClawEndpoint, sessionKey: identity.sessionKey },
      target: { kind: 'model-selection' },
      input: {
        endpoint: openClawEndpoint,
        sessionKey: identity.sessionKey,
        endpointSessionId: 'main',
        modelSelectionId: 'openai/gpt-5.4',
      },
    });
  });

  it('rejects OpenClaw model selection when the input session key is only the native handle', async () => {
    const identity = { endpoint: openClawEndpoint, agentId: 'designer-agent', sessionKey: 'agent:designer-agent:main' };
    const select = vi.fn();

    await expect(dispatchSessionCapability({
      id: 'session.modelSelection',
      operationId: 'sessions.patchModel',
      scope: { kind: 'session', identity },
      target: { kind: 'model-selection', identity, modelSelectionId: 'openai/gpt-5.4' },
      input: {
        sessionKey: 'main',
        endpointSessionId: 'main',
        sessionIdentity: identity,
        modelSelectionId: 'openai/gpt-5.4',
      },
    }, { runtimeHostTransports: { sessionModelSelectionTransport: { select } } } as never)).rejects.toThrow('Session model selection request is invalid');
    expect(select).not.toHaveBeenCalled();
  });

  it('passes Matcha endpointSessionId through model selection without replacing the Host key', async () => {
    const identity = { endpoint: matchaEndpoint, agentId: 'matcha', sessionKey: 'matcha-agent:matcha:native-session-1' };
    const select = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'succeeded' } });

    await expect(dispatchSessionCapability({
      id: 'session.modelSelection',
      operationId: 'sessions.patchModel',
      scope: { kind: 'session', identity },
      target: { kind: 'model-selection', identity, modelSelectionId: 'openai/gpt-5.4' },
      input: {
        sessionKey: identity.sessionKey,
        endpointSessionId: 'native-session-1',
        sessionIdentity: identity,
        modelSelectionId: 'openai/gpt-5.4',
      },
    }, { runtimeHostTransports: { sessionModelSelectionTransport: { select } } } as never)).resolves.toEqual({
      status: 200,
      body: { outcome: 'succeeded' },
    });
    expect(select).toHaveBeenCalledWith({
      id: 'session.modelSelection',
      operationId: 'sessions.patchModel',
      scope: { kind: 'session', endpoint: matchaEndpoint, sessionKey: identity.sessionKey },
      target: { kind: 'model-selection' },
      input: {
        endpoint: matchaEndpoint,
        sessionKey: identity.sessionKey,
        endpointSessionId: 'native-session-1',
        modelSelectionId: 'openai/gpt-5.4',
      },
    });
  });

  it('rejects non-OpenClaw model selection requests when the input session key is not the bound identity', async () => {
    const identity = { endpoint: matchaEndpoint, agentId: 'default', sessionKey: 'matcha-session-1' };
    const select = vi.fn();

    await expect(dispatchSessionCapability({
      id: 'session.modelSelection',
      operationId: 'sessions.patchModel',
      scope: { kind: 'session', identity },
      target: { kind: 'model-selection', identity, modelSelectionId: 'openai/gpt-5.4' },
      input: {
        sessionKey: 'native-session-1',
        endpointSessionId: 'native-session-1',
        sessionIdentity: identity,
        modelSelectionId: 'openai/gpt-5.4',
      },
    }, { runtimeHostTransports: { sessionModelSelectionTransport: { select } } } as never)).rejects.toThrow('Session model selection request is invalid');
    expect(select).not.toHaveBeenCalled();
  });
});
