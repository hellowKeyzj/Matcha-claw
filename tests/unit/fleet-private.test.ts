import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

type CredentialInput = {
  operationId: string;
  credentialId: string;
  credentialName: 'sshPassword' | 'sshPrivateKey' | 'dockerBearerToken' | 'kubeBearerToken';
  plaintextValue: string;
};

const input: CredentialInput = {
  operationId: 'operation-1',
  credentialId: 'node-1',
  credentialName: 'sshPassword',
  plaintextValue: 'private-secret',
};

const rawReceipt = {
  credentialRef: 'remote-fleet://credentials/node-1/sshPassword',
  operationId: 'operation-1',
  credentialName: 'sshPassword',
  writtenAt: '2026-08-08T10:00:00.000Z',
};

const receipt = {
  operationId: 'operation-1',
  credentialName: 'sshPassword',
  credentialRef: {
    kind: 'secret-ref',
    ref: 'remote-fleet://credentials/node-1/sshPassword',
  },
  writtenAt: '2026-08-08T10:00:00.000Z',
} as const;

function issuer() {
  return { verificationKey: 'public', signDecision: vi.fn(() => 'signed-decision') };
}

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('Fleet private credential adapter', () => {
  it('sends plaintext only through the private fleet owner loopback route and returns a private receipt', async () => {
    const delivery = issuer();
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => rawReceipt });
    const { writeFleetCredential } = await import('../../electron/main/runtime-host-delivery/transport/fleet-credentials');

    await expect(writeFleetCredential({ issuer: delivery, runtimeHostTransportPort: 34_125, fetcher }, input)).resolves.toEqual(receipt);

    expect(delivery.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'electron-main-local',
      endpoint: '/api/fleet/credentials/write',
      scope: 'fleet:credentials:write',
      capability: 'fleet.credentials.write',
      subject: 'fleet.credentials',
      revision: '1',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34125/api/fleet/credentials/write', expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer signed-decision',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    }));
    expect(JSON.stringify(await writeFleetCredential({ issuer: delivery, runtimeHostTransportPort: 34_125, fetcher }, input))).not.toContain(input.plaintextValue);
  });

  it.each([
    {},
    { ...input, operationId: '' },
    { ...input, credentialId: '../node-1' },
    { ...input, credentialName: 'unsupported' },
    { ...input, plaintextValue: ' ' },
    { ...input, extra: 'not-allowed' },
  ])('rejects invalid input as 400 without dispatching plaintext', async (invalidInput) => {
    const delivery = issuer();
    const fetcher = vi.fn();
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/runtime-host-delivery/transport/fleet-credentials');

    const error = await writeFleetCredential({ issuer: delivery, runtimeHostTransportPort: 34_125, fetcher }, invalidInput).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(error).toMatchObject({ kind: 'invalid', status: 400 });
    expect(delivery.signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain('private-secret');
  });

  it('maps the Rust operation conflict to 409 without returning target or plaintext data', async () => {
    const delivery = issuer();
    const fetcher = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({ success: false, error: 'Fleet credential operation conflicts with an existing receipt.' }),
    });
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/runtime-host-delivery/transport/fleet-credentials');

    const error = await writeFleetCredential({ issuer: delivery, runtimeHostTransportPort: 34_125, fetcher }, input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(error).toMatchObject({
      kind: 'conflict',
      status: 409,
      message: 'Fleet credential operation conflicts with an existing receipt.',
    });
    expect(JSON.stringify(error)).not.toContain(input.plaintextValue);
    expect(JSON.stringify(error)).not.toContain(rawReceipt.credentialRef);
  });

  it.each([
    { status: 401, body: { success: false, error: 'Fleet authorization is invalid' } },
    { status: 503, body: { success: false, error: 'storage failed' } },
  ])('maps unavailable or failed loopback outcomes to 503', async ({ status, body }) => {
    const delivery = issuer();
    const fetcher = vi.fn().mockResolvedValue({ status, json: async () => body });
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/runtime-host-delivery/transport/fleet-credentials');

    const error = await writeFleetCredential({ issuer: delivery, runtimeHostTransportPort: 34_125, fetcher }, input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(error).toMatchObject({ kind: 'unavailable', status: 503 });
  });

  it('maps invalid loopback input to 400 and transport failures to 503', async () => {
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/runtime-host-delivery/transport/fleet-credentials');
    const invalid = await writeFleetCredential({
      issuer: issuer(),
      runtimeHostTransportPort: 34_125,
      fetcher: vi.fn().mockResolvedValue({ status: 400, json: async () => ({ success: false, error: 'Fleet request is invalid' }) }),
    }, input).catch((value: unknown) => value);
    expect(invalid).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(invalid).toMatchObject({ kind: 'invalid', status: 400 });

    const unavailable = await writeFleetCredential({
      issuer: issuer(),
      runtimeHostTransportPort: 34_125,
      fetcher: vi.fn().mockRejectedValue(new Error('loopback unavailable')),
    }, input).catch((value: unknown) => value);
    expect(unavailable).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(unavailable).toMatchObject({ kind: 'unavailable', status: 503 });
  });

  it('fails closed on a receipt that does not match the requested credential target', async () => {
    const delivery = issuer();
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ ...rawReceipt, credentialRef: 'remote-fleet://credentials/other-node/sshPassword' }),
    });
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/runtime-host-delivery/transport/fleet-credentials');

    const error = await writeFleetCredential({ issuer: delivery, runtimeHostTransportPort: 34_125, fetcher }, input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(error).toMatchObject({ kind: 'unavailable', status: 503 });
    expect(JSON.stringify(error)).not.toContain(input.plaintextValue);
  });

  it('registers the Renderer IPC handler on the private channel', async () => {
    const write = vi.fn().mockResolvedValue(receipt);
    const { registerFleetPrivateHandlers } = await import('../../electron/main/ipc/fleet-private');

    registerFleetPrivateHandlers({ write });
    await expect(handlers.get('fleet:writeCredential')?.({}, input)).resolves.toMatchObject({
      operationId: 'operation-1',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: rawReceipt.credentialRef },
    });
    expect(write).toHaveBeenCalledWith(input);
  });
});
