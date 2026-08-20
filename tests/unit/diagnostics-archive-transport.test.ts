import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticsArchiveTransport } from '../../electron/main/runtime-host-delivery/transport/diagnostics';

const receipt = {
  archiveId: '0123456789abcdef0123456789abcdef',
  terminal: 'completed',
  entries: 1,
  bytes: 512,
} as const;

describe('Electron Main diagnostics archive transport', () => {
  it('signs the fixed archive operation and projects only its opaque receipt', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => receipt,
    });
    const transport = createDiagnosticsArchiveTransport(
      { verificationKey: 'public', signDecision },
      34_104,
      fetcher,
    );

    await expect(transport.archive()).resolves.toEqual({ status: 200, body: receipt });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/diagnostics/archive',
      scope: 'diagnostics:write',
      capability: 'diagnostics.archive',
      subject: 'host-diagnostics',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34104/api/diagnostics/archive', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: '{}',
    }));
  });

  it.each([
    { ...receipt, path: 'C:/private/archive.zip' },
    { ...receipt, reveal: true },
    { ...receipt, log: 'private-log-canary' },
    { ...receipt, logs: ['private-log-canary'] },
    { ...receipt, config: 'private-config-canary' },
    { ...receipt, workspace: 'private-workspace-canary' },
    { ...receipt, transcript: 'private-transcript-canary' },
    { ...receipt, session: 'private-session-canary' },
    { ...receipt, secret: 'private-secret-canary' },
    { ...receipt, token: 'private-token-canary' },
    { ...receipt, error: 'private-raw-error-canary' },
    { ...receipt, terminal: 'cancelled' },
    { ...receipt, terminal: 'failed' },
    { ...receipt, terminal: 'unknown' },
    { ...receipt, archiveId: 'private-archive-id' },
    { ...receipt, entries: 1.5 },
    { ...receipt, bytes: -1 },
  ])('fails closed for a response outside the fixed opaque receipt', async (body) => {
    const transport = createDiagnosticsArchiveTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_104,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    const response = await transport.archive();
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Diagnostics archive is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('private');
    expect(JSON.stringify(response)).not.toContain('reveal');
    expect(JSON.stringify(response)).not.toContain('raw-error');
  });

  it('downloads only an exact ZIP response with the read decision', async () => {
    const signDecision = vi.fn().mockReturnValue('download-decision');
    const zip = Buffer.from('PK\\x03\\x04diagnostics');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ archiveId: receipt.archiveId, data: zip.toString('base64') }),
    });
    const transport = createDiagnosticsArchiveTransport(
      { verificationKey: 'public', signDecision },
      34_104,
      fetcher,
    );

    await expect(transport.download(receipt.archiveId)).resolves.toEqual({ status: 200, body: zip });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/diagnostics/archive/download',
      scope: 'diagnostics:read',
      capability: 'diagnostics.archive.download',
      subject: 'host-diagnostics',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34104/api/diagnostics/archive/download', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ archiveId: receipt.archiveId }),
    }));
  });

  it.each([
    { archiveId: receipt.archiveId, data: Buffer.from('not zip').toString('base64') },
    { archiveId: receipt.archiveId, data: '!!!!' },
    { archiveId: 'private-archive-id', data: Buffer.from('PK\\x03\\x04').toString('base64') },
    { archiveId: receipt.archiveId, data: Buffer.alloc(2 * 1024 * 1024 + 1, 0x50).toString('base64') },
    { archiveId: receipt.archiveId, data: Buffer.from('PK\\x03\\x04').toString('base64'), extra: true },
  ])('fails closed for malformed or bounded download payloads', async (body) => {
    const transport = createDiagnosticsArchiveTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_104,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(transport.download(receipt.archiveId)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Diagnostics archive is unavailable' },
    });
  });

  it('projects a not-found download without exposing Rust details', async () => {
    const transport = createDiagnosticsArchiveTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_104,
      vi.fn().mockResolvedValue({ status: 404, json: async () => ({ path: 'private' }) }),
    );

    await expect(transport.download(receipt.archiveId)).resolves.toEqual({
      status: 404,
      body: { success: false, error: 'Diagnostics archive was not found' },
    });
  });

  it('redacts abort and native transport failures as unavailable', async () => {
    const transport = createDiagnosticsArchiveTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_104,
      vi.fn().mockRejectedValue(new Error('native archive at C:/private/archive.zip')),
    );

    const response = await transport.archive();
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Diagnostics archive is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('C:/private/archive.zip');
  });
});
