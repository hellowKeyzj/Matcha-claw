import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { posix, win32 } from 'node:path';
import { shell } from 'electron';
import type { HostEventBus } from '../../api/event-bus';
import { parseJsonBody, sendJson } from '../../api/route-utils';

const CALLBACK_VERSION = 1;
const DISPATCH_TOKEN_HEADER = 'x-runtime-host-dispatch-token';
const GATEWAY_EVENT_PATH = '/internal/runtime-host/gateway-events';
const SHELL_ACTION_PATH = '/internal/runtime-host/shell-actions';
const SHELL_OPEN_PATH_ACTION = 'shell_open_path';

const GATEWAY_EVENT_NAMES = new Set([
  'gateway:lifecycle',
  'gateway:notification',
  'session:update',
  'task:snapshot',
  'gateway:channel-status',
  'gateway:error',
  'team:event',
]);

type ParentCallbackEvent = Readonly<{
  readonly version: number;
  readonly eventName: string;
  readonly payload: unknown;
}>;

type ParentShellAction = Readonly<{
  readonly version: number;
  readonly action: string;
  readonly payload: unknown;
}>;

export type ParentCallbackReceiver = Readonly<{
  readonly baseUrl: string;
  readonly dispatchToken: string;
  readonly close: () => Promise<void>;
}>;

export async function createParentCallbackReceiver(
  eventBus: HostEventBus,
): Promise<ParentCallbackReceiver> {
  const dispatchToken = randomBytes(32).toString('hex');
  const server = createServer((req, res) => {
    void handleParentCallbackRequest(req, res, dispatchToken, eventBus);
  });
  server.on('upgrade', (_req, socket) => {
    socket.destroy();
  });

  await listenOnLoopback(server);
  const address = server.address();
  if (!address || typeof address === 'string' || typeof address.port !== 'number') {
    await closeServer(server);
    throw new Error('Parent callback receiver did not expose a loopback address.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispatchToken,
    close: () => closeServer(server),
  };
}

async function handleParentCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchToken: string,
  eventBus: HostEventBus,
): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname !== GATEWAY_EVENT_PATH && pathname !== SHELL_ACTION_PATH) {
    sendJson(res, 404, { version: CALLBACK_VERSION, success: false, status: 404 });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { version: CALLBACK_VERSION, success: false, status: 405 });
    return;
  }
  if (!hasDispatchToken(req, dispatchToken)) {
    sendJson(res, 403, { version: CALLBACK_VERSION, success: false, status: 403 });
    return;
  }
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    sendJson(res, 415, { version: CALLBACK_VERSION, success: false, status: 415 });
    return;
  }

  let body: unknown;
  try {
    body = await parseJsonBody<unknown>(req);
  } catch {
    sendJson(res, 400, { version: CALLBACK_VERSION, success: false, status: 400 });
    return;
  }

  if (pathname === SHELL_ACTION_PATH) {
    await handleParentShellAction(res, body);
    return;
  }

  if (!isParentCallbackEvent(body)) {
    sendJson(res, 400, { version: CALLBACK_VERSION, success: false, status: 400 });
    return;
  }

  if (!GATEWAY_EVENT_NAMES.has(body.eventName)) {
    sendJson(res, 400, { version: CALLBACK_VERSION, success: false, status: 400 });
    return;
  }

  eventBus.emit(body.eventName, body.payload);
  sendJson(res, 200, {
    version: CALLBACK_VERSION,
    success: true,
    status: 200,
    data: { accepted: true },
  });
}

async function handleParentShellAction(
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  if (!isParentShellAction(body)) {
    sendJson(res, 400, { version: CALLBACK_VERSION, success: false, status: 400 });
    return;
  }

  if (body.action !== SHELL_OPEN_PATH_ACTION) {
    sendJson(res, 400, { version: CALLBACK_VERSION, success: false, status: 400 });
    return;
  }

  const pathToOpen = parseShellOpenPathPayload(body.payload);
  if (!pathToOpen) {
    sendJson(res, 400, { version: CALLBACK_VERSION, success: false, status: 400 });
    return;
  }

  const openError = await shell.openPath(pathToOpen);
  if (openError) {
    sendJson(res, 500, {
      version: CALLBACK_VERSION,
      success: false,
      status: 500,
      error: { code: 'SHELL_OPEN_PATH_FAILED', message: 'Failed to open path.' },
    });
    return;
  }

  sendJson(res, 200, {
    version: CALLBACK_VERSION,
    success: true,
    status: 200,
    data: { opened: true },
  });
}

function isParentCallbackEvent(value: unknown): value is ParentCallbackEvent {
  return isRecord(value)
    && hasExactKeys(value, ['version', 'eventName', 'payload'])
    && value.version === CALLBACK_VERSION
    && typeof value.eventName === 'string';
}

function isParentShellAction(value: unknown): value is ParentShellAction {
  return isRecord(value)
    && hasExactKeys(value, ['version', 'action', 'payload'])
    && value.version === CALLBACK_VERSION
    && typeof value.action === 'string';
}

function parseShellOpenPathPayload(payload: unknown): string | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['path'])) return null;
  const pathValue = payload.path;
  if (typeof pathValue !== 'string') return null;
  const trimmedPath = pathValue.trim();
  if (!trimmedPath || trimmedPath.includes('\0')) return null;
  if (!win32.isAbsolute(trimmedPath) && !posix.isAbsolute(trimmedPath)) return null;
  return trimmedPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasDispatchToken(req: IncomingMessage, expected: string): boolean {
  const value = req.headers[DISPATCH_TOKEN_HEADER];
  const provided = Array.isArray(value) ? value[0] : value;
  if (!provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
