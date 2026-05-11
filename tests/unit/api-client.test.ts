import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  invokeIpc,
  invokeIpcWithRetry,
  AppError,
  toUserMessage,
  initializeDefaultTransports,
} from '@/lib/api-client';

describe('api-client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('forwards invoke arguments and returns result', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({ ok: true });

    const result = await invokeIpc<{ ok: boolean }>('app:version');

    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('app:version');
  });

  it('normalizes timeout errors', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockRejectedValueOnce(new Error('Gateway Timeout'));

    await expect(invokeIpc('gateway:status')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('retries once for retryable errors', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce('MatchaClaw');

    const result = await invokeIpcWithRetry<string>('app:name', [], 1);

    expect(result).toBe('MatchaClaw');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'app:name');
    expect(invoke).toHaveBeenNthCalledWith(2, 'app:name');
  });

  it('returns user-facing message for permission error', () => {
    const msg = toUserMessage(new AppError('PERMISSION', 'forbidden'));
    expect(msg).toContain('Permission denied');
  });

  it('returns user-facing message for auth invalid error', () => {
    const msg = toUserMessage(new AppError('AUTH_INVALID', 'Invalid Authentication'));
    expect(msg).toContain('Authentication failed');
  });

  it('returns user-facing message for channel unavailable error', () => {
    const msg = toUserMessage(new AppError('CHANNEL_UNAVAILABLE', 'Invalid IPC channel'));
    expect(msg).toContain('Service channel unavailable');
  });

  it('sends tuple payload for multi-arg requests', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({ success: true });

    const result = await invokeIpc<{ success: boolean }>('settings:set', 'language', 'en');

    expect(result.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('settings:set', 'language', 'en');
  });

  it('uses direct ipc for shell channels', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce('MatchaClaw');

    await expect(invokeIpc('app:name')).resolves.toEqual('MatchaClaw');

    expect(invoke).toHaveBeenNthCalledWith(1, 'app:name');
  });

  it('keeps renderer backend transport on the single IPC path', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({ ok: true });

    initializeDefaultTransports();

    await expect(invokeIpc('hostapi:fetch', { path: '/api/settings' })).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('hostapi:fetch', { path: '/api/settings' });
  });
});
