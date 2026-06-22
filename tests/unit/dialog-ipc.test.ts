import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialogMock = vi.fn();
const showSaveDialogMock = vi.fn();
const showMessageBoxMock = vi.fn();
const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const statMock = vi.fn();
const copyFileMock = vi.fn();
const mkdirMock = vi.fn();

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialogMock(...args),
    showSaveDialog: (...args: unknown[]) => showSaveDialogMock(...args),
    showMessageBox: (...args: unknown[]) => showMessageBoxMock(...args),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  },
}));

vi.mock('node:fs/promises', () => {
  const fsPromises = {
    readFile: (...args: unknown[]) => readFileMock(...args),
    writeFile: (...args: unknown[]) => writeFileMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
    copyFile: (...args: unknown[]) => copyFileMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
  };
  return {
    ...fsPromises,
    default: fsPromises,
  };
});

vi.mock('node:crypto', () => {
  const cryptoMock = {
    randomUUID: vi.fn(() => 'attachment-id'),
  };
  return {
    ...cryptoMock,
    default: cryptoMock,
  };
});

vi.mock('../../electron/main/e2e-fixture-loader', () => ({
  getE2EDialogOpenResult: vi.fn(async () => null),
}));

describe('dialog ipc', () => {
  beforeEach(() => {
    vi.resetModules();
    registeredHandlers.clear();
    showOpenDialogMock.mockReset();
    showSaveDialogMock.mockReset();
    showMessageBoxMock.mockReset();
    readFileMock.mockReset();
    writeFileMock.mockReset();
    statMock.mockReset();
    copyFileMock.mockReset();
    mkdirMock.mockReset();
  });

  it('does not register arbitrary path text file read/write channels', async () => {
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    expect(registeredHandlers.has('dialog:readTextFile')).toBe(false);
    expect(registeredHandlers.has('dialog:writeTextFile')).toBe(false);
    expect(registeredHandlers.has('dialog:readSelectedTextFile')).toBe(true);
    expect(registeredHandlers.has('dialog:writeSelectedTextFile')).toBe(true);
  });

  it('registers attachment staging only behind the dialog selection channel', async () => {
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    expect(registeredHandlers.has('dialog:stageOpenAttachments')).toBe(true);
    expect(registeredHandlers.has('files:stagePaths')).toBe(false);
  });

  it('stages files selected in the same open dialog call into outbound media', async () => {
    const sourcePath = '/tmp/photo.png';
    const outboundDir = join(homedir(), '.openclaw', 'media', 'outbound');
    const stagedPath = join(outboundDir, 'attachment-id.png');
    const previewBuffer = Buffer.from('preview-bytes');
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [sourcePath] });
    statMock.mockResolvedValue({ isFile: () => true, size: previewBuffer.length });
    readFileMock.mockResolvedValue(previewBuffer);
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:stageOpenAttachments');
    const result = await handler?.({}, { title: 'Attach', properties: ['openFile', 'multiSelections'] });

    expect(showOpenDialogMock).toHaveBeenCalledWith({ title: 'Attach', properties: ['openFile', 'multiSelections'] });
    expect(mkdirMock).toHaveBeenCalledWith(outboundDir, { recursive: true });
    expect(copyFileMock).toHaveBeenCalledWith(sourcePath, stagedPath);
    expect(result).toEqual({
      canceled: false,
      attachments: [{
        id: 'attachment-id',
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: previewBuffer.length,
        stagedPath,
        preview: `data:image/png;base64,${previewBuffer.toString('base64')}`,
      }],
    });
  });

  it('does not stage files when attachment selection is canceled', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:stageOpenAttachments');
    const result = await handler?.({}, { title: 'Attach', properties: ['openFile', 'multiSelections'] });

    expect(result).toEqual({ canceled: true });
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it('reports notFound when a selected attachment path is no longer a file', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/tmp/missing.png'] });
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:stageOpenAttachments');

    await expect(handler?.({}, { title: 'Attach' })).rejects.toThrow('notFound');
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it('reads text only from the file selected in the same dialog call', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/tmp/selected.json'] });
    readFileMock.mockResolvedValue('{"ok":true}');
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:readSelectedTextFile');
    const result = await handler?.({}, { title: 'Import', properties: ['openFile', 'multiSelections'] });

    expect(showOpenDialogMock).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openFile'] }));
    expect(readFileMock).toHaveBeenCalledWith('/tmp/selected.json', 'utf8');
    expect(result).toEqual({ canceled: false, filePath: '/tmp/selected.json', content: '{"ok":true}' });
  });

  it('writes text only to the file selected in the same save dialog call', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/tmp/export.json' });
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:writeSelectedTextFile');
    const result = await handler?.({}, { title: 'Export' }, '{"ok":true}\n');

    expect(showSaveDialogMock).toHaveBeenCalledWith({ title: 'Export' });
    expect(writeFileMock).toHaveBeenCalledWith('/tmp/export.json', '{"ok":true}\n', 'utf8');
    expect(result).toEqual({ canceled: false, filePath: '/tmp/export.json' });
  });
});
