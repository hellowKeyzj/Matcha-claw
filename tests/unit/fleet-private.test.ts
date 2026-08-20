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

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('Fleet private credential adapter', () => {
  it('sends plaintext only through fleet.credentials.write and returns a private receipt', async () => {
    const command = vi.fn().mockResolvedValue({ kind: 'succeeded', result: rawReceipt });
    const { writeFleetCredential } = await import('../../electron/main/ipc/fleet-private');

    await expect(writeFleetCredential({ command }, input)).resolves.toEqual({
      operationId: 'operation-1',
      credentialName: 'sshPassword',
      credentialRef: {
        kind: 'secret-ref',
        ref: 'remote-fleet://credentials/node-1/sshPassword',
      },
      writtenAt: '2026-08-08T10:00:00.000Z',
    });
    expect(command).toHaveBeenCalledWith({ name: 'fleet.credentials.write', input });
    expect(JSON.stringify(await writeFleetCredential({ command }, input))).not.toContain(input.plaintextValue);
  });

  it.each([
    {},
    { ...input, operationId: '' },
    { ...input, credentialId: '../node-1' },
    { ...input, credentialName: 'unsupported' },
    { ...input, plaintextValue: ' ' },
    { ...input, extra: 'not-allowed' },
  ])('rejects invalid input as 400 without dispatching plaintext', async (invalidInput) => {
    const command = vi.fn();
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/ipc/fleet-private');

    const error = await writeFleetCredential({ command }, invalidInput).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(error).toMatchObject({ kind: 'invalid', status: 400 });
    expect(command).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain('private-secret');
  });

  it('maps the Rust operation conflict to 409 without returning target or plaintext data', async () => {
    const command = vi.fn().mockResolvedValue({
      kind: 'rejected',
      error: {
        code: 'FAILED',
        message: 'Fleet credential operation conflicts with an existing receipt.',
      },
    });
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/ipc/fleet-private');

    const error = await writeFleetCredential({ command }, input).catch((value: unknown) => value);
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
    { kind: 'timed-out' },
    { kind: 'rejected', error: { code: 'UNAVAILABLE', message: 'not logged' } },
    { kind: 'rejected', error: { code: 'FAILED', message: 'storage failed' } },
  ])('maps unavailable or failed control outcomes to 503', async (outcome) => {
    const command = vi.fn().mockResolvedValue(outcome);
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/ipc/fleet-private');

    const error = await writeFleetCredential({ command }, input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(error).toMatchObject({ kind: 'unavailable', status: 503 });
  });

  it('maps invalid control input to 400 and transport failures to 503', async () => {
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/ipc/fleet-private');
    const invalid = await writeFleetCredential({
      command: vi.fn().mockResolvedValue({
        kind: 'rejected',
        error: { code: 'INVALID_INPUT', message: 'Runtime Host command input is invalid.' },
      }),
    }, input).catch((value: unknown) => value);
    expect(invalid).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(invalid).toMatchObject({ kind: 'invalid', status: 400 });

    const unavailable = await writeFleetCredential({
      command: vi.fn().mockRejectedValue(new Error('child unavailable')),
    }, input).catch((value: unknown) => value);
    expect(unavailable).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(unavailable).toMatchObject({ kind: 'unavailable', status: 503 });
  });

  it('fails closed on a receipt that does not match the requested credential target', async () => {
    const command = vi.fn().mockResolvedValue({
      kind: 'succeeded',
      result: { ...rawReceipt, credentialRef: 'remote-fleet://credentials/other-node/sshPassword' },
    });
    const { writeFleetCredential, RemoteFleetCredentialWriteError } = await import('../../electron/main/ipc/fleet-private');

    const error = await writeFleetCredential({ command }, input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RemoteFleetCredentialWriteError);
    expect(error).toMatchObject({ kind: 'unavailable', status: 503 });
    expect(JSON.stringify(error)).not.toContain(input.plaintextValue);
  });

  it('registers the Renderer IPC handler on the private channel', async () => {
    const command = vi.fn().mockResolvedValue({ kind: 'succeeded', result: rawReceipt });
    const { registerFleetPrivateHandlers } = await import('../../electron/main/ipc/fleet-private');

    registerFleetPrivateHandlers({ command });
    await expect(handlers.get('fleet:writeCredential')?.({}, input)).resolves.toMatchObject({
      operationId: 'operation-1',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: rawReceipt.credentialRef },
    });
    expect(command).toHaveBeenCalledWith({ name: 'fleet.credentials.write', input });
  });
});
