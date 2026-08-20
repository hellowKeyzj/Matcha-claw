import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialogMock = vi.fn();
const showSaveDialogMock = vi.fn();
const showMessageBoxMock = vi.fn();
const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const statMock = vi.fn();
const readdirMock = vi.fn();
const copyFileMock = vi.fn();
const mkdirMock = vi.fn();
const unlinkMock = vi.fn();
const realpathMock = vi.fn((path: string) => Promise.resolve(path));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => name === 'userData' ? 'C:\\matcha\\user-data' : '',
  },
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
    readdir: (...args: unknown[]) => readdirMock(...args),
    copyFile: (...args: unknown[]) => copyFileMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
    unlink: (...args: unknown[]) => unlinkMock(...args),
    realpath: (...args: unknown[]) => realpathMock(...args),
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

const getE2EDialogOpenResultMock = vi.fn(async () => null);
const getE2EDialogStagedAttachmentsMock = vi.fn(async () => null);

vi.mock('@electron/e2e-fixture-loader', () => ({
  getE2EDialogOpenResult: getE2EDialogOpenResultMock,
  getE2EDialogStagedAttachments: getE2EDialogStagedAttachmentsMock,
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
    readdirMock.mockReset();
    copyFileMock.mockReset();
    mkdirMock.mockReset();
    unlinkMock.mockReset();
    unlinkMock.mockResolvedValue(undefined);
    realpathMock.mockReset();
    realpathMock.mockImplementation((path: string) => Promise.resolve(path));
    getE2EDialogOpenResultMock.mockReset();
    getE2EDialogOpenResultMock.mockResolvedValue(null);
    getE2EDialogStagedAttachmentsMock.mockReset();
    getE2EDialogStagedAttachmentsMock.mockResolvedValue(null);
  });

  it('does not register arbitrary path text file read/write channels', async () => {
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    expect(registeredHandlers.has('dialog:readTextFile')).toBe(false);
    expect(registeredHandlers.has('dialog:writeTextFile')).toBe(false);
    expect(registeredHandlers.has('dialog:readSelectedTextFile')).toBe(true);
    expect(registeredHandlers.has('dialog:writeSelectedTextFile')).toBe(true);
  });

  it('registers only Main-owned attachment staging channels', async () => {
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    expect(registeredHandlers.has('dialog:stageOpenAttachments')).toBe(true);
    expect(registeredHandlers.has('dialog:stageDroppedAttachments')).toBe(true);
    expect(registeredHandlers.has('dialog:stageRendererBufferAttachment')).toBe(true);
    expect(registeredHandlers.has('dialog:releaseStagedAttachments')).toBe(true);
    expect(registeredHandlers.has('files:stagePaths')).toBe(false);
    expect(registeredHandlers.has('files:stageBuffer')).toBe(false);
  });

  it('stages canonical renderer buffer content through the Main attachment root', async () => {
    const attachmentStagingDirectory = join('C:\\matcha\\user-data', 'attachments');
    const stagedPath = join(attachmentStagingDirectory, 'attachment-id.png');
    const content = Buffer.from('image-data');
    mkdirMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isFile: () => true, size: content.length });
    readFileMock.mockResolvedValue(content);
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:stageRendererBufferAttachment');
    const result = await handler?.({}, {
      base64: content.toString('base64'),
      fileName: 'image.png',
      mimeType: 'image/png',
    });

    expect(writeFileMock).toHaveBeenCalledWith(stagedPath, content, { flag: 'wx' });
    expect(result).toEqual({
      stagedAttachmentId: 'attachment-id',
      fileName: 'image.png',
      mimeType: 'image/png',
      fileSize: content.length,
      preview: `data:image/png;base64,${content.toString('base64')}`,
    });

    const { consumeStagedAttachment } = await import('../../electron/main/ipc/dialog-attachment-staging');
    await expect(consumeStagedAttachment('attachment-id')).resolves.toEqual(content);
    expect(unlinkMock).toHaveBeenCalledWith(stagedPath);
    await expect(consumeStagedAttachment('attachment-id')).rejects.toThrow('unavailable');
  });

  it('idempotently releases unconsumed staged attachments without exposing custody details', async () => {
    const attachmentStagingDirectory = join('C:\\matcha\\user-data', 'attachments');
    const stagedPath = join(attachmentStagingDirectory, 'attachment-id.png');
    const content = Buffer.from('image-data');
    mkdirMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isFile: () => true, size: content.length });
    readFileMock.mockResolvedValue(content);
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const stageHandler = registeredHandlers.get('dialog:stageRendererBufferAttachment');
    await stageHandler?.({}, {
      base64: content.toString('base64'),
      fileName: 'image.png',
      mimeType: 'image/png',
    });
    const releaseHandler = registeredHandlers.get('dialog:releaseStagedAttachments');

    await expect(releaseHandler?.({}, ['attachment-id', 'attachment-id', 'missing-id'])).resolves.toBeUndefined();
    expect(unlinkMock).toHaveBeenCalledWith(stagedPath);
    await expect(releaseHandler?.({}, ['attachment-id'])).resolves.toBeUndefined();
    const { consumeStagedAttachment } = await import('../../electron/main/ipc/dialog-attachment-staging');
    await expect(consumeStagedAttachment('attachment-id')).rejects.toThrow('unavailable');
  });

  it('copies a staged attachment without accepting a renderer source path', async () => {
    const attachmentStagingDirectory = join('C:\\matcha\\user-data', 'attachments');
    const stagedPath = join(attachmentStagingDirectory, 'attachment-id.png');
    const destinationPath = 'C:\\user\\Downloads\\saved.png';
    const content = Buffer.from('image-data');
    mkdirMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isFile: () => true, size: content.length });
    readFileMock.mockResolvedValue(content);
    const { stageRendererBufferAttachment, copyStagedAttachment } = await import('../../electron/main/ipc/dialog-attachment-staging');

    await stageRendererBufferAttachment({
      base64: content.toString('base64'),
      fileName: 'image.png',
      mimeType: 'image/png',
    });
    await expect(copyStagedAttachment('attachment-id', destinationPath)).resolves.toBeUndefined();

    expect(copyFileMock).toHaveBeenCalledWith(stagedPath, destinationPath);
    expect(unlinkMock).toHaveBeenCalledWith(stagedPath);
    await expect(copyStagedAttachment('attachment-id', destinationPath)).rejects.toThrow('unavailable');
    await expect(copyStagedAttachment('C:\\outside\\source.png', destinationPath)).rejects.toThrow('unavailable');
  });

  it('cleans up an escaped staged attachment and makes it unavailable', async () => {
    const attachmentStagingDirectory = join('C:\\matcha\\user-data', 'attachments');
    const stagedPath = join(attachmentStagingDirectory, 'attachment-id.png');
    const escapedPath = 'C:\\outside\\attachment-id.png';
    const content = Buffer.from('image-data');
    mkdirMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isFile: () => true, size: content.length });
    readFileMock.mockResolvedValue(content);
    const { stageRendererBufferAttachment, consumeStagedAttachment } = await import('../../electron/main/ipc/dialog-attachment-staging');

    await stageRendererBufferAttachment({
      base64: content.toString('base64'),
      fileName: 'image.png',
      mimeType: 'image/png',
    });
    realpathMock.mockImplementation((path: string) => Promise.resolve(
      path === stagedPath ? escapedPath : path,
    ));

    await expect(consumeStagedAttachment('attachment-id')).rejects.toThrow('unavailable');
    expect(unlinkMock).toHaveBeenCalledWith(stagedPath);
    await expect(consumeStagedAttachment('attachment-id')).rejects.toThrow('unavailable');
  });

  it('cleans up when staging discovers its file escaped the attachment root', async () => {
    const attachmentStagingDirectory = join('C:\\matcha\\user-data', 'attachments');
    const stagedPath = join(attachmentStagingDirectory, 'attachment-id.png');
    const escapedPath = 'C:\\outside\\attachment-id.png';
    const content = Buffer.from('image-data');
    mkdirMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isFile: () => true, size: content.length });
    realpathMock.mockImplementation((path: string) => Promise.resolve(
      path === stagedPath ? escapedPath : path,
    ));
    const { stageRendererBufferAttachment, consumeStagedAttachment } = await import('../../electron/main/ipc/dialog-attachment-staging');

    await expect(stageRendererBufferAttachment({
      base64: content.toString('base64'),
      fileName: 'image.png',
      mimeType: 'image/png',
    })).rejects.toThrow('invalid');
    expect(unlinkMock).toHaveBeenCalledWith(stagedPath);
    await expect(consumeStagedAttachment('attachment-id')).rejects.toThrow('unavailable');
  });

  it('cleans up when consuming a staged attachment cannot read its metadata', async () => {
    const attachmentStagingDirectory = join('C:\\matcha\\user-data', 'attachments');
    const stagedPath = join(attachmentStagingDirectory, 'attachment-id.png');
    const content = Buffer.from('image-data');
    mkdirMock.mockResolvedValue(undefined);
    statMock.mockResolvedValueOnce({ isFile: () => true, size: content.length })
      .mockRejectedValueOnce(new Error('stat failure'));
    readFileMock.mockResolvedValue(content);
    const { stageRendererBufferAttachment, consumeStagedAttachment } = await import('../../electron/main/ipc/dialog-attachment-staging');

    await stageRendererBufferAttachment({
      base64: content.toString('base64'),
      fileName: 'image.png',
      mimeType: 'image/png',
    });

    await expect(consumeStagedAttachment('attachment-id')).rejects.toThrow('unavailable');
    expect(unlinkMock).toHaveBeenCalledWith(stagedPath);
    await expect(consumeStagedAttachment('attachment-id')).rejects.toThrow('unavailable');
  });

  it('cleans up when consuming a staged attachment cannot read its bytes', async () => {
    const attachmentStagingDirectory = join('C:\\matcha\\user-data', 'attachments');
    const stagedPath = join(attachmentStagingDirectory, 'attachment-id.png');
    const content = Buffer.from('image-data');
    mkdirMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isFile: () => true, size: content.length });
    readFileMock.mockResolvedValueOnce(content).mockRejectedValueOnce(new Error('read failure'));
    const { stageRendererBufferAttachment, consumeStagedAttachment } = await import('../../electron/main/ipc/dialog-attachment-staging');

    await stageRendererBufferAttachment({
      base64: content.toString('base64'),
      fileName: 'image.png',
      mimeType: 'image/png',
    });

    await expect(consumeStagedAttachment('attachment-id')).rejects.toThrow('unavailable');
    expect(unlinkMock).toHaveBeenCalledWith(stagedPath);
    await expect(consumeStagedAttachment('attachment-id')).rejects.toThrow('unavailable');
  });

  it('rejects malformed renderer buffer staging requests before writing', async () => {
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:stageRendererBufferAttachment');
    await expect(handler?.({}, {
      base64: 'not base64',
      fileName: 'image.png',
      mimeType: 'image/png',
    })).rejects.toThrow('invalid');
    await expect(handler?.({}, {
      base64: Buffer.from('image-data').toString('base64'),
      fileName: 'image.png',
    })).rejects.toThrow('invalid');
    await expect(handler?.({}, {
      base64: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64'),
      fileName: 'image.png',
      mimeType: 'image/png',
    })).rejects.toThrow('invalid');
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('stages dropped paths only through the Main-owned dialog handler', async () => {
    const sourcePath = '/tmp/dropped.txt';
    const attachmentStagingDirectory = join('C:\\matcha\\user-data', 'attachments');
    const stagedPath = join(attachmentStagingDirectory, 'attachment-id.txt');
    mkdirMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isFile: () => true, size: 4 });
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:stageDroppedAttachments');
    await expect(handler?.({}, [sourcePath])).resolves.toEqual({
      attachments: [{
        stagedAttachmentId: 'attachment-id',
        fileName: 'dropped.txt',
        mimeType: 'text/plain',
        fileSize: 4,
        preview: null,
      }],
    });
    expect(copyFileMock).toHaveBeenCalledWith(sourcePath, stagedPath, expect.any(Number));
  });

  it('opens the native dialog for general file selection', async () => {
    const result = { canceled: false, filePaths: ['/tmp/selected.txt'] };
    showOpenDialogMock.mockResolvedValue(result);
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:open');

    await expect(handler?.({}, { title: 'Select file' })).resolves.toEqual(result);
    expect(showOpenDialogMock).toHaveBeenCalledWith({ title: 'Select file' });
  });

  it('uses the E2E open-dialog result without opening a native dialog', async () => {
    const result = { canceled: false, filePaths: ['C:\\mock\\notes.txt'] };
    getE2EDialogOpenResultMock.mockResolvedValue(result);
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:open');

    await expect(handler?.({}, { title: 'Select file' })).resolves.toEqual(result);
    expect(showOpenDialogMock).not.toHaveBeenCalled();
  });

  it('returns E2E staged attachments without opening a native dialog', async () => {
    const attachments = [{
      stagedAttachmentId: 'e2e-notes-txt',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      fileSize: 18,
      preview: null,
    }];
    getE2EDialogStagedAttachmentsMock.mockResolvedValue(attachments);
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:stageOpenAttachments');

    await expect(handler?.({}, { title: 'Attach' })).resolves.toEqual({ canceled: false, attachments });
    expect(showOpenDialogMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it('stages files selected in the same open dialog call into Electron-owned attachments', async () => {
    const sourcePath = '/tmp/photo.png';
    const attachmentStagingDirectory = join('C:\\matcha\\user-data', 'attachments');
    const stagedPath = join(attachmentStagingDirectory, 'attachment-id.png');
    const previewBuffer = Buffer.from('preview-bytes');
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [sourcePath] });
    statMock.mockResolvedValue({ isFile: () => true, size: previewBuffer.length });
    readFileMock.mockResolvedValue(previewBuffer);
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:stageOpenAttachments');
    const result = await handler?.({}, { title: 'Attach', properties: ['openFile', 'multiSelections'] });

    expect(showOpenDialogMock).toHaveBeenCalledWith({ title: 'Attach', properties: ['openFile', 'multiSelections'] });
    expect(mkdirMock).toHaveBeenCalledWith(attachmentStagingDirectory, { recursive: true });
    expect(copyFileMock).toHaveBeenCalledWith(sourcePath, stagedPath, expect.any(Number));
    expect(result).toEqual({
      canceled: false,
      attachments: [{
        stagedAttachmentId: 'attachment-id',
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: previewBuffer.length,
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

  it('reads markdown skill imports into a manifest-derived DTO', async () => {
    const sourcePath = 'C:\\skills\\web-search.md';
    const content = '---\nname: Web Search\ndescription: Search the web\n---\n';
    statMock.mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: content.length });
    readFileMock.mockResolvedValue(content);
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:readSkillImport');
    await expect(handler?.({}, sourcePath)).resolves.toEqual({
      canceled: false,
      kind: 'markdown',
      skillKey: 'web-search',
      content,
    });
    expect(readFileMock).toHaveBeenCalledWith(sourcePath, 'utf8');
  });

  it('reads bundle skill imports without projecting the native root path', async () => {
    const root = 'C:\\skills\\web-search';
    const manifest = '---\r\nname: Web Search\r\ndescription: Search the web\r\n---\r\n';
    statMock.mockImplementation(async (path: string) => path === root
      ? { isFile: () => false, isDirectory: () => true }
      : { isFile: () => true, isDirectory: () => false, size: manifest.length });
    readdirMock.mockResolvedValueOnce([{
      name: 'SKILL.md',
      isDirectory: () => false,
      isFile: () => true,
    }]);
    readFileMock.mockResolvedValue(manifest);
    const { registerDialogHandlers } = await import('../../electron/main/ipc/dialog-ipc');
    registerDialogHandlers();

    const handler = registeredHandlers.get('dialog:readSkillImport');
    const result = await handler?.({}, root);
    expect(result).toEqual({
      canceled: false,
      kind: 'bundle',
      skillKey: 'web-search',
      files: [{ path: 'SKILL.md', content: manifest }],
    });
    expect(JSON.stringify(result)).not.toContain(root);
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
