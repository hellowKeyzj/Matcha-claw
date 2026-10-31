import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { WorldPrivateAdmissionError } from './private-admission';
import { configuredConnection, type WorldDelivery, type WorldTransport } from './transport';
import {
  parseWorldSourceCredential, requireWorldSourceCredential,
  storeWorldSourceCredential, WorldSourceCredentialError,
} from './source-credentials';

export async function configureWorldConnection(
  input: unknown, runtime: Promise<WorldTransport>, signal: AbortSignal, admit: () => Promise<void>,
): Promise<WorldDelivery> {
  let dispatching = false;
  try {
    await admit();
    if (!isRecord(input) || !(hasExactKeys(input, ['request', 'credential']) || hasExactKeys(input, ['request']))) {
      return { outcome: 'not-attempted', reason: 'invalid-request' };
    }
    const body: unknown = JSON.parse(JSON.stringify(input.request));
    const configured = configuredConnection(body);
    if (!configured) return { outcome: 'not-attempted', reason: 'invalid-request' };
    const transport = await runtime;
    await admit();
    const kind = (configured.connection.config as { kind: string }).kind;
    if (kind === 'plugin') {
      if (Object.hasOwn(input, 'credential')) return { outcome: 'not-attempted', reason: 'invalid-request' };
    } else if (Object.hasOwn(input, 'credential')) {
      const credential = parseWorldSourceCredential(input.credential);
      if ((kind === 'postgres' && credential.kind !== 'postgres')
        || (kind === 'http_json' && credential.kind !== 'none' && credential.kind !== 'http_bearer')) {
        return { outcome: 'not-attempted', reason: 'invalid-request' };
      }
      await storeWorldSourceCredential(configured.identity, configured.connection, credential, admit);
    } else {
      await requireWorldSourceCredential(configured.identity, configured.connection);
    }
    // Persist first, then deliver only the public command. A lost observer or even a
    // failure response does not prove rollback; keep the immutable credential binding.
    dispatching = true;
    return await transport.request('command', body, signal, undefined, admit);
  } catch (error) {
    if (dispatching) return { outcome: 'unknown' };
    if (error instanceof WorldPrivateAdmissionError) return { outcome: 'not-attempted', reason: error.reason };
    return { outcome: 'not-attempted', reason: error instanceof WorldSourceCredentialError
      ? error.code === 'credential-missing' || error.code === 'credential-revision-conflict' ? error.code : 'credential-unavailable'
      : 'invalid-request' };
  }
}
