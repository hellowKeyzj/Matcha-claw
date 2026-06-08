import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialogMock = vi.fn();
const showSaveDialogMock = vi.fn();
const showMessageBoxMock = vi.fn();
const readFileMock = vi.fn();
const writeFileMock = vi.fn();

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
  };
  return {
    ...fsPromises,
    default: fsPromises,
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
  });

  it('does not register arbitrary path text file read/write channels', async () => {
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    expect(registeredHandlers.has('dialog:readTextFile')).toBe(false);
    expect(registeredHandlers.has('dialog:writeTextFile')).toBe(false);
    expect(registeredHandlers.has('dialog:readSelectedTextFile')).toBe(true);
    expect(registeredHandlers.has('dialog:writeSelectedTextFile')).toBe(true);
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
