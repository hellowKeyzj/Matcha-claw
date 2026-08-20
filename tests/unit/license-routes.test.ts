import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LicenseService } from '../../electron/main/license/service';
import { handleLicenseRoutes } from '../../electron/api/routes/license';

type ResponseFixture = {
  statusCode: number;
  body: unknown;
};

function request(method = 'GET') {
  return Object.assign(Readable.from([]), { method, headers: {} });
}

function response() {
  const state: ResponseFixture = { statusCode: 200, body: undefined };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

describe('license routes', () => {
  it('returns the established safe projections without plaintext license data', async () => {
    const privateKey = 'MATCHACLAW-AAAA-BBBB-CCCC-SAFE';
    const service = new LicenseService({
      gate: vi.fn().mockResolvedValue({
        state: 'granted',
        reason: 'valid',
        checkedAtMs: 1,
        hasStoredKey: true,
        hasUsableCache: true,
        nextRevalidateAtMs: null,
        lastValidation: {
          valid: true,
          code: 'valid',
          normalizedKey: privateKey,
          mode: 'checksum',
          message: 'private validation detail',
        },
        renewalAlert: null,
        privateDiagnostic: 'private runtime detail',
      }),
      storedKey: vi.fn().mockResolvedValue(privateKey),
      validate: vi.fn(),
      revalidate: vi.fn(),
      clear: vi.fn(),
    } as never);
    const gate = response();
    const storedKey = response();

    await expect(handleLicenseRoutes(
      request() as never,
      gate.raw as never,
      new URL('http://127.0.0.1/api/license/gate'),
      { licenseService: service },
    )).resolves.toBe(true);
    await expect(handleLicenseRoutes(
      request() as never,
      storedKey.raw as never,
      new URL('http://127.0.0.1/api/license/stored-key'),
      { licenseService: service },
    )).resolves.toBe(true);

    expect(gate.state).toEqual({
      statusCode: 200,
      body: {
        state: 'granted',
        reason: 'valid',
        checkedAtMs: 1,
        hasStoredKey: true,
        hasUsableCache: true,
        nextRevalidateAtMs: null,
        lastValidation: {
          valid: true,
          code: 'valid',
          mode: 'checksum',
          masked: 'MATCHACLAW-****-****-****-SAFE',
          last4: 'SAFE',
        },
        renewalAlert: null,
      },
    });
    expect(storedKey.state).toEqual({
      statusCode: 200,
      body: {
        hasStoredKey: true,
        masked: 'MATCHACLAW-****-****-****-SAFE',
        last4: 'SAFE',
      },
    });
    expect(JSON.stringify([gate.state.body, storedKey.state.body])).not.toContain(privateKey);
    expect(JSON.stringify([gate.state.body, storedKey.state.body])).not.toContain('private validation detail');
    expect(JSON.stringify([gate.state.body, storedKey.state.body])).not.toContain('private runtime detail');
  });

  it('maps service failures to a stable public error', async () => {
    const service = {
      gate: vi.fn().mockRejectedValue(new Error('private storage failure')),
      storedKey: vi.fn(),
    };
    const result = response();

    await expect(handleLicenseRoutes(
      request() as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/license/gate'),
      { licenseService: service } as never,
    )).resolves.toBe(true);

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'License service is unavailable' },
    });
  });

  it('claims only the two fixed GET routes', async () => {
    const service = { gate: vi.fn(), storedKey: vi.fn() };

    await expect(handleLicenseRoutes(
      request('POST') as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/license/gate'),
      { licenseService: service } as never,
    )).resolves.toBe(false);
    await expect(handleLicenseRoutes(
      request() as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/license/validate'),
      { licenseService: service } as never,
    )).resolves.toBe(false);

    expect(service.gate).not.toHaveBeenCalled();
    expect(service.storedKey).not.toHaveBeenCalled();
  });
});
