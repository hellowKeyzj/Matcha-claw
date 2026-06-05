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

  it('POST /api/files/write-text is not handled by main process', async () => {
    const { handleFileRoutes } = await import('../../electron/api/routes/files');
    const handled = await handleFileRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/files/write-text'),
      {} as never,
    );

    expect(handled).toBe(false);
    expect(parseJsonBodyMock).not.toHaveBeenCalled();
    expect(sendJsonMock).not.toHaveBeenCalled();
  });
});
