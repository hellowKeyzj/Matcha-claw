import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeHostDeliveryIssuer,
} from '../../electron/main/runtime-host-delivery/issuer';
import {
  createSessionModelSelectionTransport,
} from '../../electron/main/runtime-host-delivery/transport/sessions/model-selection';

const request = {
  id: 'session.modelSelection' as const,
  operationId: 'sessions.patchModel' as const,
  scope: {
    kind: 'session' as const,
    endpoint: {
      kind: 'native-runtime' as const,
      runtimeAdapterId: 'openclaw' as const,
      runtimeInstanceId: 'local' as const,
    },
    sessionKey: 'agent:main:session-1',
  },
  target: { kind: 'model-selection' as const },
  input: {
    endpoint: {
      kind: 'native-runtime' as const,
      runtimeAdapterId: 'openclaw' as const,
      runtimeInstanceId: 'local' as const,
    },
    sessionKey: 'agent:main:session-1',
    endpointSessionId: 'session-1',
    modelSelectionId: 'anthropic/claude-opus-4-6',
  },
};

const runtimeHostTransportPort = 32_111;

describe('session model selection delivery transport', () => {
  it('binds a model-only capability decision to the fixed localhost endpoint', async () => {
    const succeeded = {
      outcome: 'succeeded',
      modelState: {
        selected: { provider: 'anthropic', model: 'claude-opus-4-6', ref: 'anthropic/claude-opus-4-6' },
      },
    } as const;
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => succeeded,
    });
    const transport = createSessionModelSelectionTransport(
      createRuntimeHostDeliveryIssuer(),
      runtimeHostTransportPort,
      fetcher,
    );

    await expect(transport.select(request)).resolves.toEqual({
      status: 200,
      body: succeeded,
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:32111/api/sessions/model', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(request),
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers.Authorization as string;
    const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(decision, 'base64url').toString())).toMatchObject({
      endpoint: '/api/sessions/model',
      scope: 'sessions:write',
      capability: 'sessions.patchModel',
      subject: 'session-model-selection',
    });
  });

  it('projects transport timeout as unavailable instead of invalid request', async () => {
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError');
    const transport = createSessionModelSelectionTransport(
      createRuntimeHostDeliveryIssuer(),
      runtimeHostTransportPort,
      vi.fn().mockRejectedValue(timeoutError),
    );

    await expect(transport.select(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session model selection is unavailable' },
    });
  });

  it('projects malformed, rejected and unknown native responses without delivery details', async () => {
    const issuer = createRuntimeHostDeliveryIssuer();
    const invalid = createSessionModelSelectionTransport(issuer, runtimeHostTransportPort, vi.fn());
    await expect(invalid.select({ ...request, input: { ...request.input, modelSelectionId: ' ' } })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session model selection is unavailable' },
    });

    const rejected = createSessionModelSelectionTransport(issuer, runtimeHostTransportPort, vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: 'target_rejected' }),
    }));
    await expect(rejected.select(request)).resolves.toEqual({
      status: 200,
      body: { outcome: 'target_rejected' },
    });

    const unknown = createSessionModelSelectionTransport(issuer, runtimeHostTransportPort, vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: 'outcome_unknown' }),
    }));
    await expect(unknown.select(request)).resolves.toEqual({
      status: 200,
      body: { outcome: 'outcome_unknown' },
    });
  });
});
