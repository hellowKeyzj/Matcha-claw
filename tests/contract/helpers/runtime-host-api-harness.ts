import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRuntimeHostProcessManager } from '../../../electron/main/runtime-host-process-manager';
import {
  RUNTIME_HOST_TRANSPORT_VERSION,
  type RuntimeHostRequestMethod,
  type RuntimeHostTransportResponse,
} from '../../../electron/main/runtime-host-contract';

interface ParentApiServer {
  close: () => Promise<void>;
}

export interface RuntimeHostApiHarness {
  readonly port: number;
  readonly paths: {
    readonly rootDir: string;
    readonly openclawConfigDir: string;
    readonly runtimeHostDataDir: string;
  };
  readonly dispatch: <TData = unknown>(
    method: RuntimeHostRequestMethod,
    route: string,
    payload?: unknown,
  ) => Promise<RuntimeHostTransportResponse<TData>>;
  readonly dispatchOk: <TData = unknown>(
    method: RuntimeHostRequestMethod,
    route: string,
    payload?: unknown,
  ) => Promise<TData>;
  readonly stop: () => Promise<void>;
}

interface RuntimeHostApiHarnessOptions {
  readonly pluginExecutionEnabled?: boolean;
  readonly enabledPluginIds?: string[];
  readonly pluginCatalog?: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', (error) => {
      rejectPort(error);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => {
          rejectPort(new Error('无法分配可用端口'));
        });
        return;
      }
      const selectedPort = address.port;
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(selectedPort);
      });
    });
  });
}

function createParentResponse(res: ServerResponse, payload: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function startParentApiServer(port: number, token: string): Promise<ParentApiServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      createParentResponse(res, {
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        success: false,
        status: 404,
        error: { code: 'NOT_FOUND', message: 'only POST is supported' },
      }, 404);
      return;
    }

    if (req.headers['x-runtime-host-dispatch-token'] !== token) {
      createParentResponse(res, {
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        success: false,
        status: 403,
        error: { code: 'FORBIDDEN', message: 'invalid dispatch token' },
      }, 403);
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;

    if (req.url === '/internal/runtime-host/execution-sync') {
      createParentResponse(res, {
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        success: true,
        status: 200,
        data: {
          execution: {
            pluginExecutionEnabled: true,
            enabledPluginIds: [],
          },
          action: body.action,
          payload: body.payload,
        },
      });
      return;
    }

    if (req.url === '/internal/runtime-host/shell-actions') {
      createParentResponse(res, {
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        success: true,
        status: 200,
        data: {
          success: true,
          action: body.action,
          payload: body.payload,
        },
      });
      return;
    }

    if (req.url === '/internal/runtime-host/gateway-events') {
      createParentResponse(res, {
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        success: true,
        status: 200,
        data: { received: true },
      });
      return;
    }

    createParentResponse(res, {
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      success: false,
      status: 404,
      error: { code: 'NOT_FOUND', message: `unknown endpoint: ${String(req.url)}` },
    }, 404);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      resolveListen();
    });
  });

  return {
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    },
  };
}

export async function createRuntimeHostApiHarness(
  options: RuntimeHostApiHarnessOptions = {},
): Promise<RuntimeHostApiHarness> {
  const rootDir = mkdtempSync(join(tmpdir(), 'runtime-host-api-chain-'));
  const openclawConfigDir = join(rootDir, 'openclaw-config');
  const runtimeHostDataDir = join(rootDir, 'runtime-host-data');
  mkdirSync(openclawConfigDir, { recursive: true });
  mkdirSync(runtimeHostDataDir, { recursive: true });
  writeFileSync(join(openclawConfigDir, 'openclaw.json'), '{}\n', 'utf8');

  const [runtimeHostPort, parentApiPort] = await Promise.all([findFreePort(), findFreePort()]);
  const parentDispatchToken = `runtime-host-test-token-${randomUUID()}`;
  const parentApiServer = await startParentApiServer(parentApiPort, parentDispatchToken);

  const scriptPath = resolve(process.cwd(), 'runtime-host', 'api', 'host-process.cjs');
  const manager = createRuntimeHostProcessManager({
    scriptPath,
    port: runtimeHostPort,
    startTimeoutMs: 12000,
    parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
    parentDispatchToken,
    childEnv: () => ({
      OPENCLAW_CONFIG_DIR: openclawConfigDir,
      MATCHACLAW_RUNTIME_HOST_DATA_DIR: runtimeHostDataDir,
      MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: options.pluginExecutionEnabled === false ? '0' : '1',
      MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(options.enabledPluginIds ?? []),
      MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG: JSON.stringify(options.pluginCatalog ?? []),
    }),
  });

  await manager.start();

  const dispatch = async <TData = unknown>(
    method: RuntimeHostRequestMethod,
    route: string,
    payload?: unknown,
  ): Promise<RuntimeHostTransportResponse<TData>> => {
    const response = await fetch(`http://127.0.0.1:${runtimeHostPort}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        method,
        route,
        ...(payload === undefined ? {} : { payload }),
      }),
    });
    return await response.json() as RuntimeHostTransportResponse<TData>;
  };

  const dispatchOk = async <TData = unknown>(
    method: RuntimeHostRequestMethod,
    route: string,
    payload?: unknown,
  ): Promise<TData> => {
    const envelope = await dispatch<TData>(method, route, payload);
    if (!isRecord(envelope) || envelope.success !== true) {
      throw new Error(`runtime-host transport failed: ${JSON.stringify(envelope)}`);
    }
    return envelope.data as TData;
  };

  return {
    port: runtimeHostPort,
    paths: {
      rootDir,
      openclawConfigDir,
      runtimeHostDataDir,
    },
    dispatch,
    dispatchOk,
    stop: async () => {
      await manager.stop();
      await parentApiServer.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

