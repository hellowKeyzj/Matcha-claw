import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceWriteTransport } from '../../electron/main/runtime-host-delivery/transport/workspace/write-text';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const request = {
  id: 'workspace.file',
  operationId: 'files.writeText',
  scope: { kind: 'session', endpoint, sessionKey: 'agent:main:demo' },
  target: { kind: 'workspace-file' },
  input: { endpoint, sessionKey: 'agent:main:demo', relativePath: 'docs/notes.txt', content: 'notes' },
} as const;

const unavailable = { success: false, error: 'Workspace write is unavailable' } as const;

describe('Electron Main workspace write transport', () => {
  it('signs and forwards only the fixed session-relative write request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ name: 'notes.txt', size: 5 }) });
    const transport = createWorkspaceWriteTransport({ verificationKey: 'public', signDecision }, 34_106, fetcher);

    await expect(transport.write(request)).resolves.toEqual({ status: 200, body: { name: 'notes.txt', size: 5 } });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/workspace/files/write-text',
      scope: 'workspace-files:write',
      capability: 'files.writeText',
      subject: 'workspace-write',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34106/api/workspace/files/write-text',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
        body: JSON.stringify(request),
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('workspaceRoot');
  });

  it.each([
    { ...request, input: { ...request.input, relativePath: '../secret.txt' } },
    { ...request, input: { ...request.input, content: 'x'.repeat(2 * 1024 * 1024 + 1) } },
    { ...request, privatePath: 'C:/private/root/notes.txt' },
  ])('rejects malformed, absolute-path, and oversized renderer input before issuing a decision', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createWorkspaceWriteTransport({ verificationKey: 'public', signDecision }, 34_106, fetcher);

    await expect(transport.write(invalid)).resolves.toEqual({ status: 503, body: unavailable });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'Workspace write path is invalid',
    'Workspace write target is not a file',
    'Workspace write content exceeds the limit',
    'Workspace write outcome is unknown',
  ])('preserves the sealed 422 result %s', async (error) => {
    const transport = createWorkspaceWriteTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_106,
      vi.fn().mockResolvedValue({ status: 422, json: async () => ({ success: false, error }) }),
    );

    await expect(transport.write(request)).resolves.toEqual({ status: 422, body: { success: false, error } });
  });

  it('redacts malformed and native transport failures as unavailable', async () => {
    const transport = createWorkspaceWriteTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_106,
      vi.fn().mockRejectedValue(new Error('private native failure at C:/workspace/root with secret-token')),
    );

    const response = await transport.write(request);
    expect(response).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(response)).not.toContain('C:/workspace/root');
    expect(JSON.stringify(response)).not.toContain('secret-token');
  });
});
