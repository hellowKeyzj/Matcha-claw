import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceDirectoryTransport } from '../../electron/main/runtime-host-delivery/transport/workspace/read-directory';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const request = {
  id: 'workspace.file',
  operationId: 'files.listDir',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'workspace-file' },
  input: { endpoint, sessionKey: 'agent:main:demo', relativePath: '', includeHidden: false },
} as const;

const unavailable = { success: false, error: 'Workspace directory is unavailable' } as const;

describe('Electron Main workspace directory transport', () => {
  it('signs and forwards only the fixed session-relative directory request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ entries: [{ relativePath: 'docs', display: 'docs', isDirectory: true, size: 0 }] }),
    });
    const transport = createWorkspaceDirectoryTransport({ verificationKey: 'public', signDecision }, 34_105, fetcher);

    await expect(transport.list(request)).resolves.toEqual({
      status: 200,
      body: { entries: [{ relativePath: 'docs', display: 'docs', isDirectory: true, size: 0 }] },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/workspace/files/list-dir',
      scope: 'workspace-files:list',
      capability: 'files.listDir',
      subject: 'workspace-directory',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34105/api/workspace/files/list-dir',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
        body: JSON.stringify(request),
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('workspaceRoot');
  });

  it('preserves includeHidden and accepts complete directory responses above 256 entries', async () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      relativePath: `.entry-${index}`,
      display: `.entry-${index}`,
      isDirectory: false,
      size: 0,
    }));
    const hiddenRequest = { ...request, input: { ...request.input, includeHidden: true } };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ entries }) });
    const transport = createWorkspaceDirectoryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_105,
      fetcher,
    );

    await expect(transport.list(hiddenRequest)).resolves.toEqual({ status: 200, body: { entries } });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34105/api/workspace/files/list-dir',
      expect.objectContaining({ body: JSON.stringify(hiddenRequest) }),
    );
  });

  it.each([
    { ...request, input: { ...request.input, relativePath: '../secret' } },
    { ...request, privatePath: 'C:/private/root' },
  ])('rejects malformed or absolute-path renderer input before issuing a decision', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createWorkspaceDirectoryTransport({ verificationKey: 'public', signDecision }, 34_105, fetcher);

    await expect(transport.list(invalid)).resolves.toEqual({ status: 503, body: unavailable });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves only sealed 422 results and redacts native failures', async () => {
    const transport = createWorkspaceDirectoryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_105,
      vi.fn().mockResolvedValueOnce({
        status: 422,
        json: async () => ({ success: false, error: 'Workspace directory target is not a directory' }),
      }).mockRejectedValueOnce(new Error('private native failure at C:/workspace/root with secret-token')),
    );

    await expect(transport.list(request)).resolves.toEqual({
      status: 422,
      body: { success: false, error: 'Workspace directory target is not a directory' },
    });
    const response = await transport.list(request);
    expect(response).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(response)).not.toContain('C:/workspace/root');
    expect(JSON.stringify(response)).not.toContain('secret-token');
  });
});
