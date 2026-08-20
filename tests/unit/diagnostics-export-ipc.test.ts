import { beforeEach, describe, expect, it, vi } from 'vitest';

const CHANNEL = 'diagnostics:exportArchive';
const archiveId = '0123456789abcdef0123456789abcdef';
const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  },
}));

describe('diagnostics export IPC', () => {
  const downloadMock = vi.fn();
  const showSaveDialogMock = vi.fn();
  const writeFileMock = vi.fn();
  const getE2ESavePathMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    registeredHandlers.clear();
    downloadMock.mockReset();
    showSaveDialogMock.mockReset();
    writeFileMock.mockReset();
    getE2ESavePathMock.mockReset();
    getE2ESavePathMock.mockResolvedValue(null);

    const { registerDiagnosticsExportHandler } = await import('../../electron/main/ipc/diagnostics-export-ipc');
    registerDiagnosticsExportHandler({
      transport: { download: downloadMock },
      showSaveDialog: showSaveDialogMock,
      writeFile: writeFileMock,
      getE2ESavePath: getE2ESavePathMock,
    });
  });

  async function invoke(input: unknown) {
    const handler = registeredHandlers.get(CHANNEL);
    if (!handler) throw new Error('diagnostics export handler was not registered');
    return handler({}, input);
  }

  it.each([
    undefined,
    null,
    archiveId,
    {},
    { archiveId: '0123456789ABCDEF0123456789ABCDEF' },
    { archiveId: '0123456789abcdef0123456789abcdeg' },
    { archiveId },
  ].map((input, index) => index === 6 ? { archiveId, extra: true } : input))(
    'rejects invalid renderer input before dialog, download, or write',
    async (input) => {
      await expect(invoke(input)).resolves.toEqual({ status: 'failed' });

      expect(getE2ESavePathMock).not.toHaveBeenCalled();
      expect(showSaveDialogMock).not.toHaveBeenCalled();
      expect(downloadMock).not.toHaveBeenCalled();
      expect(writeFileMock).not.toHaveBeenCalled();
    },
  );

  it('does not download or write when the save dialog is cancelled', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined });

    await expect(invoke({ archiveId })).resolves.toEqual({ status: 'cancelled' });

    expect(showSaveDialogMock).toHaveBeenCalledWith({
      title: 'Save diagnostics archive',
      defaultPath: `diagnostics-${archiveId}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    expect(downloadMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('seals a download failure without writing', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:/private/archive.zip' });
    downloadMock.mockResolvedValue({
      status: 503,
      body: { success: false, error: 'private transport failure' },
    });

    const result = await invoke({ archiveId });

    expect(result).toEqual({ status: 'failed' });
    expect(downloadMock).toHaveBeenCalledWith(archiveId);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('downloads and writes archive bytes, returning only saved status', async () => {
    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:/private/archive.zip' });
    downloadMock.mockResolvedValue({ status: 200, body: bytes });
    writeFileMock.mockResolvedValue(undefined);

    const result = await invoke({ archiveId });

    expect(downloadMock).toHaveBeenCalledWith(archiveId);
    expect(writeFileMock).toHaveBeenCalledWith('C:/private/archive.zip', bytes);
    expect(result).toEqual({ status: 'saved' });
    expect(Object.keys(result as object)).toEqual(['status']);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('seals write failures without returning the path or raw error', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:/private/archive.zip' });
    downloadMock.mockResolvedValue({ status: 200, body: Uint8Array.from([0x50, 0x4b]) });
    writeFileMock.mockRejectedValue(new Error('disk full at C:/private/archive.zip'));

    const result = await invoke({ archiveId });

    expect(result).toEqual({ status: 'failed' });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('disk full');
  });
});
