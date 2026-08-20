import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceTextTransport } from '../../electron/main/runtime-host-delivery/transport/workspace/read-text';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const request = {
  id: 'workspace.file',
  operationId: 'files.readText',
  scope: {
    kind: 'session',
    endpoint,
    sessionKey: 'agent:main:demo',
  },
  target: { kind: 'workspace-file' },
  input: {
    endpoint,
    sessionKey: 'agent:main:demo',
    relativePath: 'docs/notes.txt',
  },
} as const;

const unavailable = {
  success: false,
  error: 'Workspace text is unavailable',
} as const;

describe('Electron Main workspace text transport', () => {
  it('signs and forwards only the fixed session-relative request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ name: 'docs/notes.txt', content: 'notes', size: 5 }),
    });
    const transport = createWorkspaceTextTransport({ verificationKey: 'public', signDecision }, 34_105, fetcher);

    await expect(transport.read(request)).resolves.toEqual({
      status: 200,
      body: { name: 'docs/notes.txt', content: 'notes', size: 5 },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/workspace/files/read-text',
      scope: 'workspace-files:read',
      capability: 'files.readText',
      subject: 'workspace-text',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34105/api/workspace/files/read-text',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
        body: JSON.stringify(request),
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('workspaceRoot');
  });

  it.each([
    { ...request, input: { ...request.input, relativePath: '' } },
    { ...request, input: { ...request.input, relativePath: '../secret.txt' } },
    { ...request, input: { ...request.input, maxBytes: Number.NaN } },
    { ...request, privatePath: 'C:/private/root/notes.txt' },
  ])('rejects malformed or absolute-path renderer input before issuing a decision', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createWorkspaceTextTransport({ verificationKey: 'public', signDecision }, 34_105, fetcher);

    await expect(transport.read(invalid)).resolves.toEqual({ status: 503, body: unavailable });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('clamps a requested read limit to the legacy text bounds before forwarding', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ name: 'docs/notes.txt', content: 'notes', size: 5 }),
    });
    const transport = createWorkspaceTextTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_105,
      fetcher,
    );

    await expect(transport.read({
      ...request,
      input: { ...request.input, maxBytes: 0 },
    })).resolves.toEqual({
      status: 200,
      body: { name: 'docs/notes.txt', content: 'notes', size: 5 },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34105/api/workspace/files/read-text',
      expect.objectContaining({
        body: JSON.stringify({
          ...request,
          input: { ...request.input, maxBytes: 1 },
        }),
      }),
    );

    await transport.read({
      ...request,
      input: { ...request.input, maxBytes: 3 * 1024 * 1024 },
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      'http://127.0.0.1:34105/api/workspace/files/read-text',
      expect.objectContaining({
        body: JSON.stringify({
          ...request,
          input: { ...request.input, maxBytes: 2 * 1024 * 1024 },
        }),
      }),
    );
  });

  it.each([
    ['Workspace text path is invalid', 'Workspace text path is invalid'],
    ['Workspace text target is not a file', 'Workspace text target is not a file'],
    ['Workspace text target exceeds the limit', 'Workspace text target exceeds the limit'],
    ['Workspace text target is binary', 'Workspace text target is binary'],
  ])('preserves the sealed 422 result %s', async (_name, error) => {
    const transport = createWorkspaceTextTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_105,
      vi.fn().mockResolvedValue({ status: 422, json: async () => ({ success: false, error }) }),
    );

    await expect(transport.read(request)).resolves.toEqual({
      status: 422,
      body: { success: false, error },
    });
  });

  it('redacts malformed and native transport failures as unavailable', async () => {
    const transport = createWorkspaceTextTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_105,
      vi.fn().mockRejectedValue(new Error('private native failure at C:/workspace/root with secret-token')),
    );

    const response = await transport.read(request);
    expect(response).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(response)).not.toContain('C:/workspace/root');
    expect(JSON.stringify(response)).not.toContain('secret-token');
  });
});
