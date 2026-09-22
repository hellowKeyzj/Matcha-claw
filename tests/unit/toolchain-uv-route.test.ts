import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendJsonMock = vi.fn();
const statusMock = vi.hoisted(() => vi.fn());
const prepareMock = vi.hoisted(() => vi.fn());

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

function request(method: string) {
  return Object.assign(Readable.from([]), { method, headers: {} });
}

const toolchainTransport = {
  status: statusMock,
  prepare: prepareMock,
};

describe('Toolchain Host API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the Rust Toolchain UV state through toolchain transport', async () => {
    statusMock.mockResolvedValue({ status: 200, body: { uv: 'available', python: 'ready' } });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await expect(handleToolchainRoutes(
      request('GET') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/check'),
      toolchainTransport as never,
    )).resolves.toBe(true);

    expect(statusMock).toHaveBeenCalledWith();
    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, { installed: true });
  });

  it('returns installed false without exposing producer details when UV is absent', async () => {
    statusMock.mockResolvedValue({ status: 200, body: { uv: 'unavailable', python: 'unavailable' } });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await handleToolchainRoutes(
      request('GET') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/check?detail=private-path'),
      toolchainTransport as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, { installed: false });
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('private-path');
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('Error');
  });

  it('prepares the UV toolchain through toolchain transport', async () => {
    prepareMock.mockResolvedValue({ status: 200, body: { outcome: 'installed' } });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await expect(handleToolchainRoutes(
      request('POST') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/prepare'),
      toolchainTransport as never,
    )).resolves.toBe(true);

    expect(prepareMock).toHaveBeenCalledWith(120_000);
    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, { success: true, outcome: 'installed' });
  });

  it('returns a closed prepare failure when the Rust outcome is rejected', async () => {
    prepareMock.mockResolvedValue({ status: 200, body: { outcome: 'rejected' } });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await handleToolchainRoutes(
      request('POST') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/prepare'),
      toolchainTransport as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(response, 409, {
      success: false,
      error: 'Toolchain preparation was rejected',
    });
  });

  it('fails closed when the Rust status is unknown', async () => {
    statusMock.mockResolvedValue({ status: 503, body: { success: false, error: 'Toolchain is unavailable' } });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await handleToolchainRoutes(
      request('GET') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/check'),
      toolchainTransport as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(response, 503, {
      success: false,
      error: 'Toolchain is unavailable',
    });
  });

  it('rejects malformed Rust status without exposing producer fields', async () => {
    statusMock.mockResolvedValue({ status: 503, body: { success: false, error: 'Toolchain is unavailable' } });
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');
    const response = {} as never;

    await handleToolchainRoutes(
      request('GET') as never,
      response,
      new URL('http://localhost/api/toolchain/uv/check'),
      toolchainTransport as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(response, 503, {
      success: false,
      error: 'Toolchain is unavailable',
    });
    expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('C:/private/uv.exe');
  });

  it('does not claim other methods or paths', async () => {
    const { handleToolchainRoutes } = await import('../../electron/api/routes/toolchain');

    await expect(handleToolchainRoutes(
      request('POST') as never,
      {} as never,
      new URL('http://localhost/api/toolchain/uv/check'),
      toolchainTransport as never,
    )).resolves.toBe(false);
    await expect(handleToolchainRoutes(
      request('GET') as never,
      {} as never,
      new URL('http://localhost/api/toolchain/uv/prepare'),
      toolchainTransport as never,
    )).resolves.toBe(false);
    await expect(handleToolchainRoutes(
      request('GET') as never,
      {} as never,
      new URL('http://localhost/api/toolchain/uv/install'),
      toolchainTransport as never,
    )).resolves.toBe(false);
    expect(sendJsonMock).not.toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
  });
});
