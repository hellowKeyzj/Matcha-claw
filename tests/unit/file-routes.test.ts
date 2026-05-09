import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  parseJsonBodyMock: vi.fn(),
  sendJsonMock: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(),
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: () => ({
        toPNG: () => Buffer.from(''),
      }),
    })),
  },
}));

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => hoisted.parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => hoisted.sendJsonMock(...args),
}));

describe('file routes', () => {
  let tempHome = '';
  let recordPath = '';

  beforeEach(async () => {
    vi.resetModules();
    hoisted.parseJsonBodyMock.mockReset();
    hoisted.sendJsonMock.mockReset();
    tempHome = await mkdtemp(join(process.env.TEMP || process.cwd(), 'matcha-claw-home-'));
    recordPath = '';
  });

  afterEach(async () => {
    if (recordPath) {
      await rm(recordPath, { force: true });
    }
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves gateway outgoing-media thumbnails through local records', async () => {
    const attachmentId = `test-${randomUUID()}`;
    const originalPath = join(tempHome, 'artifact.png');
    const { homedir } = await import('node:os');
    const recordsDir = join(homedir(), '.openclaw', 'media', 'outgoing', 'records');
    recordPath = join(recordsDir, `${attachmentId}.json`);
    await mkdir(recordsDir, { recursive: true });
    await writeFile(originalPath, Buffer.from('png-bytes'));
    await writeFile(recordPath, JSON.stringify({
      original: {
        path: originalPath,
        contentType: 'image/png',
      },
    }));

    hoisted.parseJsonBodyMock.mockResolvedValueOnce({
      paths: [{
        gatewayUrl: `/api/chat/media/outgoing/agent%3Atest%3Amain/${attachmentId}/full`,
        mimeType: 'image/png',
      }],
    });

    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const handled = await handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/files/thumbnails'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      {
        [`/api/chat/media/outgoing/agent%3Atest%3Amain/${attachmentId}/full`]: {
          preview: null,
          fileSize: Buffer.from('png-bytes').length,
        },
      },
    );
  });

  it('reads text previews through main-owned file route', async () => {
    const filePath = join(tempHome, 'notes.md');
    await writeFile(filePath, '# Hello\nworld\n', 'utf8');
    hoisted.parseJsonBodyMock.mockResolvedValueOnce({ path: filePath });

    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const handled = await handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/files/read-text'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        ok: true,
        path: filePath,
        content: '# Hello\nworld\n',
        mimeType: 'text/markdown',
      }),
    );
  });

  it('returns binary error for NUL-containing text preview reads', async () => {
    const filePath = join(tempHome, 'raw.bin');
    await writeFile(filePath, Buffer.from([0x41, 0x00, 0x42]));
    hoisted.parseJsonBodyMock.mockResolvedValueOnce({ path: filePath });

    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    await handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/files/read-text'),
      {} as never,
    );

    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      { ok: false, error: 'binary' },
    );
  });

  it('reads binary previews as base64 payloads', async () => {
    const filePath = join(tempHome, 'table.xlsx');
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    await writeFile(filePath, buffer);
    hoisted.parseJsonBodyMock.mockResolvedValueOnce({ path: filePath });

    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    await handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/files/read-binary'),
      {} as never,
    );

    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        ok: true,
        path: filePath,
        data: buffer.toString('base64'),
        mimeType: 'application/octet-stream',
      }),
    );
  });

  it('lists directory entries for workspace browser reads', async () => {
    const docsDir = join(tempHome, 'docs');
    const filePath = join(docsDir, 'guide.md');
    const nestedDir = join(docsDir, 'nested');
    await mkdir(docsDir, { recursive: true });
    await mkdir(nestedDir, { recursive: true });
    await writeFile(filePath, 'guide', 'utf8');
    hoisted.parseJsonBodyMock.mockResolvedValueOnce({ path: docsDir });

    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    await handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/files/list-dir'),
      {} as never,
    );

    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      {
        ok: true,
        entries: [
          expect.objectContaining({
            name: 'nested',
            path: nestedDir,
            isDir: true,
            hasChildren: true,
          }),
          expect.objectContaining({
            name: 'guide.md',
            path: filePath,
            isDir: false,
            hasChildren: false,
          }),
        ],
      },
    );
  });
});
