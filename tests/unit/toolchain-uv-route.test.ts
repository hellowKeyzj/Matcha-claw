import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendJsonMock = vi.fn();
const commandMock = vi.hoisted(() => vi.fn());

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

function request(method: string) {
  return Object.assign(Readable.from([]), { method, headers: {} });
}

describe('Toolchain Host API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the Rust Toolchain UV state through host.toolchain.status', async () => {
    commandMock.mockResolvedValue({
      kind: 'succeeded',
      result: { result: { uv: 'available', python: 'ready' } },
    });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await expect(handleToolchainRoutes(
      request('GET') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/check'),
      { runtimeHost: { command: commandMock } } as never,
    )).resolves.toBe(true);

    expect(commandMock).toHaveBeenCalledWith({ name: 'host.toolchain.status' });
    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, { installed: true });
  });

  it('returns installed false without exposing producer details when UV is absent', async () => {
    commandMock.mockResolvedValue({
      kind: 'succeeded',
      result: { result: { uv: 'unavailable', python: 'unavailable' } },
    });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await handleToolchainRoutes(
      request('GET') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/check?detail=private-path'),
      { runtimeHost: { command: commandMock } } as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, { installed: false });
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('private-path');
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('Error');
  });

  it('prepares the UV toolchain through host.toolchain.prepare', async () => {
    commandMock.mockResolvedValue({
      kind: 'succeeded',
      result: { result: { outcome: 'installed' } },
    });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await expect(handleToolchainRoutes(
      request('POST') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/prepare'),
      { runtimeHost: { command: commandMock } } as never,
    )).resolves.toBe(true);

    expect(commandMock).toHaveBeenCalledWith(
      { name: 'host.toolchain.prepare' },
      { timeoutMs: 120_000 },
    );
    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, { success: true, outcome: 'installed' });
  });

  it('returns a closed prepare failure when the Rust outcome is rejected', async () => {
    commandMock.mockResolvedValue({
      kind: 'succeeded',
      result: { result: { outcome: 'rejected' } },
    });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await handleToolchainRoutes(
      request('POST') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/prepare'),
      { runtimeHost: { command: commandMock } } as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(response, 409, {
      success: false,
      error: 'Toolchain preparation was rejected',
    });
  });

  it('fails closed when the Rust status is unknown', async () => {
    commandMock.mockResolvedValue({
      kind: 'succeeded',
      result: { result: { uv: 'unknown', python: 'unknown' } },
    });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await handleToolchainRoutes(
      request('GET') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/check'),
      { runtimeHost: { command: commandMock } } as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(response, 503, {
      success: false,
      error: 'Toolchain is unavailable',
    });
  });

  it('rejects malformed Rust status without exposing producer fields', async () => {
    commandMock.mockResolvedValue({
      kind: 'succeeded',
      result: {
        result: { uv: 'available', python: 'ready', executable: 'C:/private/uv.exe' },
      },
    });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await handleToolchainRoutes(
      request('GET') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/check'),
      { runtimeHost: { command: commandMock } } as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(response, 503, {
      success: false,
      error: 'Toolchain is unavailable',
    });
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('C:/private/uv.exe');
  });

  it('does not claim other methods or paths', async () => {
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');

    const runtimeHost = { command: commandMock };
    await expect(handleToolchainRoutes(
      request('POST') as never,
      {} as never,
      new URL('http://localhost/api/toolchain/uv/check'),
      { runtimeHost } as never,
    )).resolves.toBe(false);
    await expect(handleToolchainRoutes(
      request('GET') as never,
      {} as never,
      new URL('http://localhost/api/toolchain/uv/prepare'),
      { runtimeHost } as never,
    )).resolves.toBe(false);
    await expect(handleToolchainRoutes(
      request('GET') as never,
      {} as never,
      new URL('http://localhost/api/toolchain/uv/install'),
      { runtimeHost } as never,
    )).resolves.toBe(false);
    expect(sendJsonMock).not.toHaveBeenCalled();
    expect(commandMock).not.toHaveBeenCalled();
  });
});
