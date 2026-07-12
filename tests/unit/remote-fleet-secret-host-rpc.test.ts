import { describe, expect, it } from 'vitest';
import {
  REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
  REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
  redactSecretResolveResponse,
  validateSecretResolveRequest,
  type RemoteFleetSecretResolveHostRpcResponse,
} from '../../runtime-host/application/remote-fleet/remote-fleet-secret-host-rpc';

describe('remote fleet secret host RPC seam', () => {
  it('validates host.secret.resolve requests for worker command execution', () => {
    const result = validateSecretResolveRequest({
      type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
      requestId: 'secret-rpc-1',
      input: {
        secretRef: 'remote-fleet://node-1/api-key',
        purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
        commandExecutionId: 'command-1',
        workerId: 'worker-1',
      },
    });

    expect(result).toEqual({
      resultType: 'valid',
      request: {
        type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
        requestId: 'secret-rpc-1',
        input: {
          secretRef: 'remote-fleet://node-1/api-key',
          purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
          commandExecutionId: 'command-1',
          workerId: 'worker-1',
        },
      },
    });
  });

  it('validates host.secret.resolve requests for terminal sessions', () => {
    const result = validateSecretResolveRequest({
      type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
      requestId: 'secret-rpc-1',
      input: {
        secretRef: 'remote-fleet://node-1/ssh-password',
        purpose: 'terminal-session',
        commandExecutionId: 'terminal-1',
      },
    });

    expect(result).toEqual({
      resultType: 'valid',
      request: {
        type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
        requestId: 'secret-rpc-1',
        input: {
          secretRef: 'remote-fleet://node-1/ssh-password',
          purpose: 'terminal-session',
          commandExecutionId: 'terminal-1',
        },
      },
    });
  });

  it('rejects plaintext secret material in requests', () => {
    const result = validateSecretResolveRequest({
      type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
      requestId: 'secret-rpc-1',
      input: {
        secretRef: 'remote-fleet://node-1/api-key',
        purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
        commandExecutionId: 'command-1',
        plaintextSecretValue: 'sk-live-secret',
      },
    });

    expect(result).toEqual({
      resultType: 'invalidRequest',
      reason: 'plaintextFieldNotAllowed',
      message: 'host.secret.resolve requests must carry a secret reference, not plaintext secret material.',
      field: 'plaintextSecretValue',
    });
  });

  it('rejects requests outside supported secret resolve purposes', () => {
    const result = validateSecretResolveRequest({
      type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
      requestId: 'secret-rpc-1',
      input: {
        secretRef: 'remote-fleet://node-1/api-key',
        purpose: 'snapshot',
        commandExecutionId: 'command-1',
      },
    });

    expect(result).toEqual({
      resultType: 'invalidRequest',
      reason: 'purposeInvalid',
      message: 'host.secret.resolve is only valid for worker command execution or terminal session setup.',
      field: 'purpose',
    });
  });

  it('redacts resolved responses before durable projection', () => {
    const response: RemoteFleetSecretResolveHostRpcResponse = {
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'resolved',
      secretRef: 'remote-fleet://node-1/api-key',
      plaintextSecretValue: 'sk-live-secret',
    };

    expect(redactSecretResolveResponse(response)).toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'resolved',
      secretRef: 'remote-fleet://node-1/api-key',
      plaintextSecretValueRedacted: true,
    });
  });

  it('preserves non-secret response branches in redacted projection', () => {
    const response: RemoteFleetSecretResolveHostRpcResponse = {
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'notFound',
      secretRef: 'remote-fleet://node-1/api-key',
    };

    expect(redactSecretResolveResponse(response)).toBe(response);
  });
});
