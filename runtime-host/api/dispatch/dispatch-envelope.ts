import { REQUEST_METHODS, TRANSPORT_VERSION } from '../common/constants';

export interface DispatchEnvelope {
  method: string;
  route: string;
  payload: unknown;
}

interface DispatchEnvelopeValidationSuccess {
  ok: true;
  value: DispatchEnvelope;
}

interface DispatchEnvelopeValidationFailure {
  ok: false;
  status: 400;
  error: {
    code: 'BAD_REQUEST';
    message: string;
  };
}

export type DispatchEnvelopeValidationResult =
  | DispatchEnvelopeValidationSuccess
  | DispatchEnvelopeValidationFailure;

export function parseDispatchEnvelope(rawBody: string): DispatchEnvelopeValidationResult {
  const parsed = rawBody ? JSON.parse(rawBody) : {};
  if (parsed.version !== TRANSPORT_VERSION) {
    return {
      ok: false,
      status: 400,
      error: {
        code: 'BAD_REQUEST',
        message: `Unsupported transport version: ${String(parsed.version)}`,
      },
    };
  }
  if (typeof parsed.method !== 'string' || !REQUEST_METHODS.has(parsed.method)) {
    return {
      ok: false,
      status: 400,
      error: {
        code: 'BAD_REQUEST',
        message: `Unsupported method: ${String(parsed.method)}`,
      },
    };
  }
  if (typeof parsed.route !== 'string' || !parsed.route.startsWith('/')) {
    return {
      ok: false,
      status: 400,
      error: {
        code: 'BAD_REQUEST',
        message: `Invalid route: ${String(parsed.route)}`,
      },
    };
  }
  return {
    ok: true,
    value: {
      method: parsed.method,
      route: parsed.route,
      payload: parsed.payload,
    },
  };
}
