import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleCapabilityRoutes } from '../../electron/api/routes/capabilities';
import { handleLicenseRoutes } from '../../electron/api/routes/license';

type ResponseFixture = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
};

function createRequest(method: string, body?: unknown) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  return Object.assign(request, { method, headers: body === undefined ? {} : { 'content-length': '1' } });
}

function createResponse(): { response: ResponseFixture; raw: { statusCode: number; setHeader: (key: string, value: string) => void; end: (content?: string) => void } } {
  const response: ResponseFixture = { statusCode: 200, headers: {}, body: null };
  return {
    response,
    raw: {
      get statusCode() { return response.statusCode; },
      set statusCode(value: number) { response.statusCode = value; },
      setHeader: (key, value) => { response.headers[key] = value; },
      end: (content) => { response.body = content ? JSON.parse(content) : null; },
    },
  };
}

function createLicenseService() {
  return {
    gate: vi.fn().mockResolvedValue({ state: 'blocked' }),
    storedKey: vi.fn().mockResolvedValue({ hasStoredKey: true, masked: 'MATCHACLAW-****-****-****-DDDD', last4: 'DDDD' }),
    validate: vi.fn().mockResolvedValue({ valid: true, code: 'valid', masked: 'MATCHACLAW-****-****-****-DDDD', last4: 'DDDD' }),
    revalidate: vi.fn().mockResolvedValue({ valid: false, code: 'empty' }),
    clear: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('License Host API routes', () => {
  it('returns only the safe gate and stored-key projections', async () => {
    const service = createLicenseService();
    const gate = createResponse();
    const storedKey = createResponse();

    await expect(handleLicenseRoutes(createRequest('GET') as never, gate.raw as never, new URL('http://localhost/api/license/gate'), { licenseService: service } as never)).resolves.toBe(true);
    await expect(handleLicenseRoutes(createRequest('GET') as never, storedKey.raw as never, new URL('http://localhost/api/license/stored-key'), { licenseService: service } as never)).resolves.toBe(true);

    expect(gate.response.body).toEqual({ state: 'blocked' });
    expect(storedKey.response.body).toEqual({ hasStoredKey: true, masked: 'MATCHACLAW-****-****-****-DDDD', last4: 'DDDD' });
    expect(JSON.stringify([gate.response.body, storedKey.response.body])).not.toContain('MATCHACLAW-AAAA-BBBB-CCCC-DDDD');
  });

  it('maps service failures to a stable public error without secret details', async () => {
    const secret = 'MATCHACLAW-AAAA-BBBB-CCCC-DDDD';
    const service = createLicenseService();
    service.gate.mockRejectedValueOnce(new Error(`private storage failure for ${secret}`));
    const response = createResponse();

    await expect(handleLicenseRoutes(
      createRequest('GET') as never,
      response.raw as never,
      new URL('http://localhost/api/license/gate'),
      { licenseService: service } as never,
    )).resolves.toBe(true);

    expect(response.response).toMatchObject({
      statusCode: 503,
      body: { success: false, error: 'License service is unavailable' },
    });
    expect(JSON.stringify(response.response.body)).not.toContain(secret);
    expect(JSON.stringify(response.response.body)).not.toContain('private storage failure');
  });

  it('does not claim non-GET or unrelated routes', async () => {
    const service = createLicenseService();

    await expect(handleLicenseRoutes(
      createRequest('POST') as never,
      createResponse().raw as never,
      new URL('http://localhost/api/license/gate'),
      { licenseService: service } as never,
    )).resolves.toBe(false);
    await expect(handleLicenseRoutes(
      createRequest('GET') as never,
      createResponse().raw as never,
      new URL('http://localhost/api/license/validate'),
      { licenseService: service } as never,
    )).resolves.toBe(false);

    expect(service.gate).not.toHaveBeenCalled();
    expect(service.storedKey).not.toHaveBeenCalled();
  });

  it('does not leak unchecked runtime-only gate fields', async () => {
    const { LicenseService } = await import('../../electron/main/license/service');
    const gate = await new LicenseService({
      gate: vi.fn().mockResolvedValue({
        state: 'granted',
        reason: 'valid',
        checkedAtMs: 1,
        hasStoredKey: true,
        hasUsableCache: true,
        nextRevalidateAtMs: null,
        lastValidation: null,
        renewalAlert: null,
        privateDiagnostic: '/private/license/path private-token',
      }),
      storedKey: vi.fn(),
      validate: vi.fn(),
      revalidate: vi.fn(),
      clear: vi.fn(),
    } as never).gate();

    expect(gate).not.toHaveProperty('privateDiagnostic');
    expect(JSON.stringify(gate)).not.toContain('/private/license/path');
    expect(JSON.stringify(gate)).not.toContain('private-token');
  });

  it('executes only the static License capability with the legacy payload shape', async () => {
    const service = createLicenseService();
    const response = createResponse();
    const payload = {
      id: 'license.runtime',
      operationId: 'license.validate',
      scope: { kind: 'app' },
      target: { kind: 'license', subject: 'key' },
      input: { key: 'MATCHACLAW-AAAA-BBBB-CCCC-DDDD' },
    };

    await expect(handleCapabilityRoutes(createRequest('POST', payload) as never, response.raw as never, new URL('http://localhost/api/capabilities/execute'), { licenseService: service } as never)).resolves.toBe(true);

    expect(response.response.statusCode).toBe(200);
    expect(response.response.body).toEqual({ valid: true, code: 'valid', masked: 'MATCHACLAW-****-****-****-DDDD', last4: 'DDDD' });
    expect(service.validate).toHaveBeenCalledWith(payload.input.key);
    expect(JSON.stringify(response.response.body)).not.toContain(payload.input.key);
  });

  it('rejects an invalid capability target without invoking License service', async () => {
    const service = createLicenseService();
    const response = createResponse();

    await handleCapabilityRoutes(createRequest('POST', {
      id: 'license.runtime',
      operationId: 'license.clear',
      scope: { kind: 'app' },
      target: { kind: 'license', subject: 'gate' },
      input: {},
    }) as never, response.raw as never, new URL('http://localhost/api/capabilities/execute'), { licenseService: service } as never);

    expect(response.response.statusCode).toBe(404);
    expect(response.response.body).toEqual({ success: false, error: 'Capability is not available' });
    expect(service.clear).not.toHaveBeenCalled();
  });

  it('does not expose an unregistered capability through the static dispatcher', async () => {
    const service = createLicenseService();
    const response = createResponse();

    await handleCapabilityRoutes(createRequest('POST', {
      id: 'runtime.host',
      operationId: 'runtimeHost.restart',
      scope: { kind: 'app' },
      target: { kind: 'license', subject: 'key' },
      input: {},
    }) as never, response.raw as never, new URL('http://localhost/api/capabilities/execute'), { licenseService: service } as never);

    expect(response.response.statusCode).toBe(404);
    expect(response.response.body).toEqual({ success: false, error: 'Capability is not available' });
  });
});
