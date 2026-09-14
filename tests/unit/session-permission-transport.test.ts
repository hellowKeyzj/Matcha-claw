import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeHostDeliveryIssuer,
} from '../../electron/main/runtime-host-delivery/bootstrap';
import {
  createSessionPermissionTransport,
  decodeSessionPermissionRequest,
} from '../../electron/main/runtime-host-delivery/transport/sessions/permission';

const openClawEndpoint = {
  kind: 'native-runtime' as const,
  runtimeAdapterId: 'openclaw' as const,
  runtimeInstanceId: 'local' as const,
};

const matchaEndpoint = {
  kind: 'native-runtime' as const,
  runtimeAdapterId: 'matcha-agent' as const,
  runtimeInstanceId: 'local' as const,
};

const identity = {
  endpoint: openClawEndpoint,
  agentId: 'main',
  sessionKey: 'agent:main:main',
};

function permissionRequest(operationId: 'sessions.permission.get' | 'sessions.permission.set', input = {}) {
  return {
    id: 'session.management' as const,
    operationId,
    scope: { kind: 'session' as const, identity },
    target: { kind: 'session' as const, identity },
    input: {
      sessionKey: identity.sessionKey,
      sessionIdentity: identity,
      ...input,
    },
  };
}

describe('session permission delivery transport', () => {
  it('binds permission get/set decisions to the fixed session permission endpoint', async () => {
    const projection = {
      supported: true,
      mode: 'guarded',
      defaultMode: 'workspace',
      pending: false,
      canSelectFull: true,
      options: ['read-only', 'guarded', 'workspace', 'full'],
    };
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => projection,
    });
    const transport = createSessionPermissionTransport(
      createRuntimeHostDeliveryIssuer(),
      3220,
      fetcher,
    );
    const request = permissionRequest('sessions.permission.set', { permissionMode: 'guarded' });

    await expect(transport.set(request)).resolves.toEqual({
      status: 200,
      body: projection,
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3220/api/sessions/permission', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(request),
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers.Authorization as string;
    const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(decision, 'base64url').toString())).toMatchObject({
      endpoint: '/api/sessions/permission',
      scope: 'sessions:write',
      capability: 'session.management',
      subject: 'session-permission',
    });
  });

  it('requires the full bound SessionIdentity instead of a naked session key', async () => {
    expect(decodeSessionPermissionRequest({
      id: 'session.management',
      operationId: 'sessions.permission.get',
      scope: { kind: 'session', sessionKey: identity.sessionKey },
      target: { kind: 'session', sessionKey: identity.sessionKey },
      input: { sessionKey: identity.sessionKey },
    })).toBeNull();
    expect(decodeSessionPermissionRequest({
      ...permissionRequest('sessions.permission.get'),
      input: {
        sessionKey: identity.sessionKey,
        sessionIdentity: { ...identity, agentId: 'other' },
      },
    })).toBeNull();
  });

  it('passes Matcha Agent identity through to the runtime session owner', async () => {
    const projection = {
      supported: false,
      mode: null,
      pending: false,
      canSelectFull: false,
      options: [],
      reason: 'Session permission is unsupported',
    };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => projection });
    const transport = createSessionPermissionTransport(createRuntimeHostDeliveryIssuer(), 3220, fetcher);
    const matchaIdentity = { endpoint: matchaEndpoint, agentId: 'default', sessionKey: 'matcha-session-1' };
    const request = {
      id: 'session.management' as const,
      operationId: 'sessions.permission.get' as const,
      scope: { kind: 'session' as const, identity: matchaIdentity },
      target: { kind: 'session' as const, identity: matchaIdentity },
      input: { sessionKey: matchaIdentity.sessionKey, sessionIdentity: matchaIdentity },
    };

    await expect(transport.get(request)).resolves.toEqual({ status: 200, body: projection });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3220/api/sessions/permission', expect.objectContaining({
      body: JSON.stringify(request),
    }));
  });

  it('redacts malformed native responses as unavailable', async () => {
    const transport = createSessionPermissionTransport(
      createRuntimeHostDeliveryIssuer(),
      3220,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({
        supported: false,
        mode: 'full',
        pending: false,
        canSelectFull: false,
        options: [],
      }) }),
    );

    await expect(transport.get(permissionRequest('sessions.permission.get'))).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session permission is unavailable' },
    });
  });
});
