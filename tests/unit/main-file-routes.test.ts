import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(),
  },
}));

describe('main file routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/files/write-text writes selected export content in main process', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-main-file-route-'));
    try {
      const filePath = join(tempDir, 'exports', 'agent.matchaclaw-agent.json');
      parseJsonBodyMock.mockResolvedValueOnce({
        path: filePath,
        content: '{"schema":"matchaclaw.agent-config"}\n',
      });

      const { handleFileRoutes } = await import('../../electron/api/routes/files');
      const handled = await handleFileRoutes(
        { method: 'POST' } as IncomingMessage,
        {} as ServerResponse,
        new URL('http://127.0.0.1:3210/api/files/write-text'),
        {} as never,
      );

      expect(handled).toBe(true);
      await expect(readFile(filePath, 'utf8')).resolves.toBe('{"schema":"matchaclaw.agent-config"}\n');
      expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
        ok: true,
        path: filePath,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
