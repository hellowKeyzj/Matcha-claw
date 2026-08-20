import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();
const writeFileMock = vi.fn();
const copyStagedAttachmentMock = vi.fn();
const showSaveDialogMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('../../electron/main/ipc/dialog-attachment-staging', () => ({
  copyStagedAttachment: (...args: unknown[]) => copyStagedAttachmentMock(...args),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: (...args: unknown[]) => writeFileMock(...args),
}));

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: (...args: unknown[]) => showSaveDialogMock(...args),
  },
}));

describe('main file routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseJsonBodyMock.mockReset();
    writeFileMock.mockReset();
    copyStagedAttachmentMock.mockReset();
    showSaveDialogMock.mockReset();
  });

  function transports(overrides: Partial<{
    workspaceTextTransport: { read: ReturnType<typeof vi.fn> };
    workspaceDirectoryTransport: { list: ReturnType<typeof vi.fn> };
    workspaceWriteTransport: { write: ReturnType<typeof vi.fn> };
  }> = {}) {
    return {
      workspaceTextTransport: { read: vi.fn() },
      workspaceDirectoryTransport: { list: vi.fn() },
      workspaceWriteTransport: { write: vi.fn() },
      ...overrides,
    };
  }

  it('projects the fixed workspace directory route', async () => {
    const workspaceDirectoryTransport = {
      list: vi.fn().mockResolvedValue({
        status: 422,
        body: { success: false, error: 'Workspace directory target is not a directory' },
      }),
    };
    parseJsonBodyMock.mockResolvedValue({ relativePath: 'docs' });
    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const response = {} as ServerResponse;

    await expect(handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/files/list-dir'),
      transports({ workspaceDirectoryTransport }) as never,
    )).resolves.toBe(true);

    expect(workspaceDirectoryTransport.list).toHaveBeenCalledWith({ relativePath: 'docs' });
    expect(sendJsonMock).toHaveBeenCalledWith(
      response,
      422,
      { success: false, error: 'Workspace directory target is not a directory' },
    );
  });

  it('projects the fixed workspace write route and redacts failures', async () => {
    const workspaceWriteTransport = {
      write: vi.fn().mockRejectedValue(new Error('native root C:/private/root token=secret')),
    };
    parseJsonBodyMock.mockResolvedValue({ relativePath: 'docs/notes.txt', content: 'notes' });
    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const response = {} as ServerResponse;

    await expect(handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/files/write-text'),
      transports({ workspaceWriteTransport }) as never,
    )).resolves.toBe(true);

    expect(workspaceWriteTransport.write).toHaveBeenCalledWith({ relativePath: 'docs/notes.txt', content: 'notes' });
    expect(sendJsonMock).toHaveBeenCalledWith(
      response,
      503,
      { success: false, error: 'Workspace write is unavailable' },
    );
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('C:/private/root');
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('secret');
  });

  it('redacts workspace text route failures', async () => {
    const workspaceTextTransport = {
      read: vi.fn().mockRejectedValue(new Error('native root C:/private/root token=secret')),
    };
    parseJsonBodyMock.mockResolvedValue({ relativePath: 'docs/notes.txt' });
    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const response = {} as ServerResponse;

    await expect(handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/files/read-text'),
      transports({ workspaceTextTransport }) as never,
    )).resolves.toBe(true);

    expect(sendJsonMock).toHaveBeenCalledWith(
      response,
      503,
      { success: false, error: 'Workspace text is unavailable' },
    );
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('C:/private/root');
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('secret');
  });

  it('does not expose image-save failure details through the Host API route', async () => {
    parseJsonBodyMock.mockRejectedValue(
      new Error('failed with Authorization: Bearer private-token at /private/image/path'),
    );
    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const response = {} as ServerResponse;

    await expect(handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/files/save-image'),
    )).resolves.toBe(true);

    expect(sendJsonMock).toHaveBeenCalledWith(
      response,
      500,
      { success: false, error: 'Image save failed.' },
    );
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('private-token');
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('/private/image/path');
  });

  it('preserves save-image cancel semantics', async () => {
    parseJsonBodyMock.mockResolvedValue({ defaultFileName: 'image.png', base64: 'aGVsbG8=' });
    showSaveDialogMock.mockResolvedValue({ canceled: true });
    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const response = {} as ServerResponse;

    await expect(handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/files/save-image'),
    )).resolves.toBe(true);

    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, { success: false });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(copyStagedAttachmentMock).not.toHaveBeenCalled();
  });

  it('saves base64 image data and bounds savedPath to the file name', async () => {
    parseJsonBodyMock.mockResolvedValue({
      defaultFileName: 'image.png',
      mimeType: 'image/png',
      base64: 'aGVsbG8=',
    });
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\exports\\saved.png' });
    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const response = {} as ServerResponse;

    await expect(handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/files/save-image'),
    )).resolves.toBe(true);

    expect(writeFileMock).toHaveBeenCalledWith('C:\\exports\\saved.png', Buffer.from('aGVsbG8=', 'base64'));
    expect(sendJsonMock).toHaveBeenCalledWith(
      response,
      200,
      { success: true, savedPath: 'saved.png' },
    );
  });

  it('copies a Main-owned staged image using only its opaque id', async () => {
    parseJsonBodyMock.mockResolvedValue({
      defaultFileName: 'image.png',
      filePath: 'attachment-id',
    });
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\exports\\saved.png' });
    copyStagedAttachmentMock.mockResolvedValue(undefined);
    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const response = {} as ServerResponse;

    await expect(handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/files/save-image'),
    )).resolves.toBe(true);

    expect(copyStagedAttachmentMock).toHaveBeenCalledWith('attachment-id', 'C:\\exports\\saved.png');
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(
      response,
      200,
      { success: true, savedPath: 'saved.png' },
    );
  });

  it('rejects an absolute legacy filePath before any filesystem copy', async () => {
    parseJsonBodyMock.mockResolvedValue({
      defaultFileName: 'image.png',
      filePath: 'C:\\private\\secret.png',
    });
    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const response = {} as ServerResponse;

    await expect(handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/files/save-image'),
    )).resolves.toBe(true);

    expect(sendJsonMock).toHaveBeenCalledWith(
      response,
      400,
      { success: false, error: 'Image source unavailable' },
    );
    expect(showSaveDialogMock).not.toHaveBeenCalled();
    expect(copyStagedAttachmentMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
