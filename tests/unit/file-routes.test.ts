import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
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
});
