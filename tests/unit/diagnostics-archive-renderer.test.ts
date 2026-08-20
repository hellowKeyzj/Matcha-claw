import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectDiagnosticsArchive, exportDiagnosticsArchive } from '@/lib/diagnostics-archive';
import { hostApiFetchDecoded } from '@/lib/host-api';

vi.mock('@/lib/host-api', () => ({
  hostApiFetchDecoded: vi.fn(),
}));

const invokeMock = vi.mocked(window.electron.ipcRenderer.invoke);

const receipt = {
  archiveId: '0123456789abcdef0123456789abcdef',
  terminal: 'completed',
  entries: 1,
  bytes: 512,
} as const;

const mockedHostApiFetchDecoded = vi.mocked(hostApiFetchDecoded);

describe('renderer diagnostics archive projection', () => {
  beforeEach(() => {
    mockedHostApiFetchDecoded.mockReset();
    invokeMock.mockReset();
  });

  it('requests the fixed route and accepts only the opaque receipt', async () => {
    mockedHostApiFetchDecoded.mockImplementation(async (_path, decode) => decode(receipt));

    await expect(collectDiagnosticsArchive()).resolves.toEqual(receipt);
    expect(mockedHostApiFetchDecoded).toHaveBeenCalledWith(
      '/api/diagnostics/archive',
      expect.any(Function),
      { method: 'POST', body: '{}', signal: undefined },
    );
  });

  it('requests the sealed Main save operation and accepts only its terminal status', async () => {
    invokeMock.mockResolvedValue({ status: 'saved' });

    await expect(exportDiagnosticsArchive(receipt.archiveId)).resolves.toEqual({ status: 'saved' });
    expect(invokeMock).toHaveBeenCalledWith('diagnostics:exportArchive', { archiveId: receipt.archiveId });
  });

  it.each([
    { ...receipt, path: 'C:/private/archive.zip' },
    { ...receipt, reveal: true },
    { ...receipt, log: 'private' },
    { ...receipt, session: 'private' },
    { ...receipt, workspace: 'private-workspace-canary' },
    { ...receipt, config: 'private-config-canary' },
    { ...receipt, transcript: 'private-transcript-canary' },
    { ...receipt, secret: 'private-secret-canary' },
    { ...receipt, token: 'private-token-canary' },
    { ...receipt, error: 'private-raw-error-canary' },
    { ...receipt, terminal: 'cancelled' },
    { ...receipt, terminal: 'failed' },
    { ...receipt, terminal: 'unknown' },
    { ...receipt, archiveId: 'private-archive-id' },
    { ...receipt, entries: 1.5 },
    { ...receipt, bytes: -1 },
  ])('rejects a payload outside the opaque receipt', async (payload) => {
    mockedHostApiFetchDecoded.mockImplementation(async (_path, decode) => decode(payload));

    await expect(collectDiagnosticsArchive()).rejects.toThrow('Diagnostics archive is unavailable.');
  });

  it('does not expose a rejected sensitive payload through its public error', async () => {
    mockedHostApiFetchDecoded.mockImplementation(async (_path, decode) => decode({
      ...receipt,
      transcript: 'private-transcript-canary',
      secret: 'private-secret-canary',
    }));

    await expect(collectDiagnosticsArchive()).rejects.toThrow('Diagnostics archive is unavailable.');
    await expect(collectDiagnosticsArchive()).rejects.not.toThrow('private');
  });
});
