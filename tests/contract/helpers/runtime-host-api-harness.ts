import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
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
  readonly waitForJob: <TResult = unknown>(jobId: string | undefined) => Promise<TResult>;
  readonly stop: () => Promise<void>;
}

interface RuntimeHostApiHarnessOptions {
  readonly enabledPluginIds?: string[];
  readonly pluginCatalog?: Array<Record<string, unknown>>;
  readonly gatewayMethods?: readonly string[];
  readonly gatewayHandler?: (input: { method: string; params: unknown }) => unknown;
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

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 80,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitForCondition timeout');
}

function createParentResponse(res: ServerResponse, payload: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function startGatewayRpcServer(input: {
  readonly port: number;
  readonly token: string;
  readonly methods: readonly string[];
  readonly handler?: (payload: { method: string; params: unknown }) => unknown;
}): Promise<ParentApiServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: input.port });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'contract-test' },
    }));
    let authed = false;
    socket.on('message', (rawData) => {
      const message = JSON.parse(rawData.toString() || '{}') as Record<string, unknown>;
      if (message.type !== 'req' || typeof message.id !== 'string') {
        return;
      }
      if (message.method === 'connect') {
        const params = isRecord(message.params) ? message.params : {};
        const auth = isRecord(params.auth) ? params.auth : {};
        if (auth.token !== input.token) {
          socket.send(JSON.stringify({ type: 'res', id: message.id, ok: false, error: { code: 'FORBIDDEN', message: 'invalid gateway token' } }));
          socket.close();
          return;
        }
        authed = true;
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: true,
          payload: { features: { methods: input.methods } },
        }));
        return;
      }
      if (!authed || typeof message.method !== 'string') {
        socket.send(JSON.stringify({ type: 'res', id: message.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'handshake not completed' } }));
        return;
      }
      socket.send(JSON.stringify({
        type: 'res',
        id: message.id,
        ok: true,
        payload: input.handler?.({ method: message.method, params: message.params }) ?? { ok: true },
      }));
    });
  });
  await new Promise<void>((resolve) => {
    wss.on('listening', () => resolve());
  });
  return {
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        wss.close((error) => {
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
  const enabledPluginIds = options.enabledPluginIds ?? [];
  writeFileSync(join(openclawConfigDir, 'openclaw.json'), `${JSON.stringify({
    ...(enabledPluginIds.length > 0 ? {
      plugins: {
        allow: enabledPluginIds,
        entries: Object.fromEntries(enabledPluginIds.map((pluginId) => [pluginId, { enabled: true }])),
      },
    } : {}),
  }, null, 2)}\n`, 'utf8');

  const [runtimeHostPort, parentApiPort, gatewayPort] = await Promise.all([findFreePort(), findFreePort(), findFreePort()]);
  const parentDispatchToken = `runtime-host-test-token-${randomUUID()}`;
  const gatewayToken = `runtime-host-gateway-token-${randomUUID()}`;
  const parentApiServer = await startParentApiServer(parentApiPort, parentDispatchToken);
  const gatewayServer = options.gatewayMethods
    ? await startGatewayRpcServer({
        port: gatewayPort,
        token: gatewayToken,
        methods: options.gatewayMethods,
        handler: options.gatewayHandler,
      })
    : null;
  if (gatewayServer) {
    writeFileSync(join(openclawConfigDir, 'matchaclaw-settings.json'), `${JSON.stringify({ gatewayToken }, null, 2)}\n`, 'utf8');
  }

  const scriptPath = resolve(process.cwd(), 'runtime-host', 'host-process.cjs');
  const childLogs: string[] = [];
  const appendChildLog = (level: string, message: string, error?: unknown): void => {
    childLogs.push(error === undefined ? `[${level}] ${message}` : `[${level}] ${message} ${String(error)}`);
  };
  const manager = createRuntimeHostProcessManager({
    scriptPath,
    port: runtimeHostPort,
    startTimeoutMs: 12000,
    parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
    parentDispatchToken,
    childEnv: () => ({
      OPENCLAW_CONFIG_DIR: openclawConfigDir,
      MATCHACLAW_RUNTIME_HOST_DATA_DIR: runtimeHostDataDir,
      MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(enabledPluginIds),
      MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG: JSON.stringify(options.pluginCatalog ?? []),
      ...(gatewayServer ? {
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(gatewayPort),
        MATCHACLAW_RUNTIME_HOST_SETTINGS_FILE: join(openclawConfigDir, 'matchaclaw-settings.json'),
      } : {}),
    }),
    logger: {
      info: (message) => appendChildLog('info', message),
      warn: (message) => appendChildLog('warn', message),
      error: (message, error) => appendChildLog('error', message, error),
    },
  });

  try {
    await manager.start();
  } catch (error) {
    await manager.stop().catch(() => undefined);
    await gatewayServer?.close();
    await parentApiServer.close();
    rmSync(rootDir, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${childLogs.join('\n')}`);
  }

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

  const waitForJob = async <TResult = unknown>(jobId: string | undefined): Promise<TResult> => {
    if (!jobId) {
      throw new Error('runtime-host jobId is required');
    }
    let result: unknown;
    await waitForCondition(async () => {
      const data = await dispatchOk<{ job: { status?: string; result?: unknown; error?: string } | null }>(
        'POST',
        '/api/capabilities/execute',
        {
          id: 'runtime.host',
          operationId: 'runtimeHost.jobGet',
          scope: { kind: 'runtime-instance', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } },
          target: { kind: 'runtime-job', jobId },
          input: { jobId },
        },
      );
      const job = data.job;
      if (!job) {
        return false;
      }
      if (job.status === 'failed') {
        throw new Error(job.error || `Runtime host job failed: ${jobId}`);
      }
      if (job.status === 'succeeded') {
        result = job.result;
        return true;
      }
      return false;
    });
    return result as TResult;
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
    waitForJob,
    stop: async () => {
      await manager.stop();
      await gatewayServer?.close();
      await parentApiServer.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
