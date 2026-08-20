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
  const sessionKey = endpoint.runtimeAdapterId === 'openclaw'
    ? 'agent:main:main'
    : 'matcha-session-1';
  return {
    id: 'session.prompt',
    operationId: 'sessions.prompt',
    scope: {
      kind: 'session',
      identity: { endpoint, agentId: 'default', sessionKey },
    },
    target: {
      kind: 'session',
      identity: { endpoint, agentId: 'default', sessionKey },
    },
    input: {
      sessionKey,
      sessionIdentity: { endpoint, agentId: 'default', sessionKey },
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

function workspaceDeps(execute: ReturnType<typeof vi.fn>) {
  return {
    deps: {
      workspaceMediaTransport: { execute },
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
      sessionSendTransport: { send },
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
        sessionTimelineTransport: { load, window },
        matchaSessionListTransport: { list },
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
});
