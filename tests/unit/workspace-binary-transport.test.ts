import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceBinaryTransport } from '../../electron/main/runtime-host-delivery/transport/workspace/read-binary';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const readRequest = {
  id: 'workspace.file',
  operationId: 'files.readBinary',
  scope: {
    kind: 'session',
    endpoint,
    sessionKey: 'agent:main:demo',
  },
  target: { kind: 'workspace-file' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    relativePath: 'docs/asset.bin',
  },
} as const;

const statRequest = {
  ...readRequest,
  operationId: 'files.stat',
} as const;

const unavailable = {
  success: false,
  error: 'Workspace binary is unavailable',
} as const;

describe('Electron Main workspace binary transport', () => {
  it('signs and forwards only fixed session-relative binary and stat requests', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ name: 'docs/asset.bin', data: 'AAE=', size: 2 }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ name: 'docs', isDirectory: true, size: 0, mtimeMs: 1_700_000_000_000 }),
      });
    const transport = createWorkspaceBinaryTransport({ verificationKey: 'public', signDecision }, 3232, fetcher);

    await expect(transport.execute(readRequest)).resolves.toEqual({
      status: 200,
      body: { name: 'docs/asset.bin', data: 'AAE=', size: 2 },
    });
    await expect(transport.execute({
      ...statRequest,
      input: { ...statRequest.input, relativePath: 'docs' },
    })).resolves.toEqual({
      status: 200,
      body: { name: 'docs', isDirectory: true, size: 0, mtimeMs: 1_700_000_000_000 },
    });
    expect(signDecision).toHaveBeenNthCalledWith(1, expect.objectContaining({
      endpoint: '/api/workspace/files/binary',
      scope: 'workspace-files:binary',
      capability: 'files.readBinary',
      subject: 'workspace-binary',
    }));
    expect(signDecision).toHaveBeenNthCalledWith(2, expect.objectContaining({
      capability: 'files.stat',
    }));
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3232/api/workspace/files/binary',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
        body: JSON.stringify(readRequest),
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('workspaceRoot');
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('C:/');
  });

  it.each([
    { ...readRequest, input: { ...readRequest.input, relativePath: '' } },
    { ...readRequest, input: { ...readRequest.input, relativePath: '../secret.bin' } },
    { ...readRequest, input: { ...readRequest.input, maxBytes: Number.NaN } },
    { ...statRequest, input: { ...statRequest.input, maxBytes: 1024 } },
    { ...readRequest, input: { ...readRequest.input, path: 'C:/private/asset.bin' } },
  ])('rejects malformed and raw-path renderer input before issuing a decision', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createWorkspaceBinaryTransport({ verificationKey: 'public', signDecision }, 3232, fetcher);

    await expect(transport.execute(invalid)).resolves.toEqual({ status: 503, body: unavailable });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('clamps a requested binary read limit to the legacy bounds before forwarding', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ name: 'docs/asset.bin', data: 'AAE=', size: 2 }),
    });
    const transport = createWorkspaceBinaryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3232,
      fetcher,
    );

    await expect(transport.execute({
      ...readRequest,
      input: { ...readRequest.input, maxBytes: 0 },
    })).resolves.toEqual({
      status: 200,
      body: { name: 'docs/asset.bin', data: 'AAE=', size: 2 },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3232/api/workspace/files/binary',
      expect.objectContaining({
        body: JSON.stringify({
          ...readRequest,
          input: { ...readRequest.input, maxBytes: 1 },
        }),
      }),
    );

    await transport.execute({
      ...readRequest,
      input: { ...readRequest.input, maxBytes: 60 * 1024 * 1024 },
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      'http://127.0.0.1:3232/api/workspace/files/binary',
      expect.objectContaining({
        body: JSON.stringify({
          ...readRequest,
          input: { ...readRequest.input, maxBytes: 50 * 1024 * 1024 },
        }),
      }),
    );
  });

  it('accepts an omitted read limit and preserves sealed 422 failures', async () => {
    const transport = createWorkspaceBinaryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3232,
      vi.fn().mockResolvedValue({
        status: 422,
        json: async () => ({ success: false, error: 'Workspace binary target exceeds the limit' }),
      }),
    );

    await expect(transport.execute(readRequest)).resolves.toEqual({
      status: 422,
      body: { success: false, error: 'Workspace binary target exceeds the limit' },
    });
  });

  it('redacts malformed and native transport failures as unavailable', async () => {
    const transport = createWorkspaceBinaryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3232,
      vi.fn().mockRejectedValue(new Error('private native failure at C:/workspace/root with secret-token')),
    );

    const response = await transport.execute(readRequest);
    expect(response).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(response)).not.toContain('C:/workspace/root');
    expect(JSON.stringify(response)).not.toContain('secret-token');
  });
});
