import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, readFile, writeFile, rm, rename, readdir, stat, realpath, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID, randomBytes } from 'node:crypto';
import { TeamRuntimeService } from '../../team-runtime-service';
import { TeamRuntimePackageService } from '../../team-runtime-package-service';
import { FileTeamRuntimeStateStore } from '../../team-runtime-state-store';
import { SqliteTeamIngressAdapter, SqliteTeamOutboxStore } from './local-sqlite';
import { TeamRuntimeMailDeliveryService } from '../../team-mail-delivery-service';
import { isTeamRuntimeDebugLoggingEnabled } from '../../team-runtime-debug-logging';
import { TeamRuntimeOutboxPoller } from '../../team-runtime-outbox-poller';
import {
  TeamRuntimeWorkerHostRpc,
  WorkerProxyTeamAgentMaterializationPort,
  WorkerProxyTeamRoleSessionPort,
  WorkerProxyTeamRuntimeJobPort,
  WorkerProxyTeamSkillCatalogPort,
} from '../../team-runtime-worker-host-proxy';
import type { RuntimeDirectoryEntry, RuntimeFileStat, RuntimeFileSystemPort } from '../../../common/runtime-ports';
import type {
  TeamRuntimeMainToWorkerMessage,
  TeamRuntimeWorkerConfig,
  TeamRuntimeWorkerRequest,
  TeamRuntimeWorkerResponse,
  TeamRuntimeWorkerToMainMessage,
} from '../../team-runtime-worker-contracts';

class WorkerRuntimeFileSystem implements RuntimeFileSystemPort {
  async exists(pathname: string): Promise<boolean> {
    return await stat(pathname).then(() => true).catch(() => false);
  }

  async ensureDirectory(pathname: string): Promise<void> {
    await mkdir(pathname, { recursive: true });
  }

  async listDirectory(pathname: string): Promise<RuntimeDirectoryEntry[]> {
    const entries = await readdir(pathname, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }));
  }

  async readTextFile(pathname: string): Promise<string> {
    return await readFile(pathname, 'utf8');
  }

  async *readTextFileLines(pathname: string): AsyncIterable<string> {
    const lines = createInterface({ input: createReadStream(pathname, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      yield line;
    }
  }

  async readBinaryFile(pathname: string): Promise<Uint8Array> {
    return await readFile(pathname);
  }

  async writeTextFile(pathname: string, content: string): Promise<void> {
    await writeFile(pathname, content, 'utf8');
  }

  async writeBinaryFile(pathname: string, content: Uint8Array): Promise<void> {
    await writeFile(pathname, content);
  }

  async writeTextFileExclusive(pathname: string, content: string): Promise<boolean> {
    try {
      await writeFile(pathname, content, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }

  async copyFile(sourcePathname: string, targetPathname: string): Promise<void> {
    await copyFile(sourcePathname, targetPathname);
  }

  async removeFile(pathname: string): Promise<void> {
    await rm(pathname, { force: true });
  }

  async removeDirectory(pathname: string): Promise<void> {
    await rm(pathname, { recursive: true, force: true });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await rename(oldPath, newPath);
  }

  async realPath(pathname: string): Promise<string> {
    return await realpath(pathname);
  }

  async stat(pathname: string): Promise<RuntimeFileStat> {
    const value = await stat(pathname);
    return { isFile: value.isFile(), isDirectory: value.isDirectory(), size: value.size, mtimeMs: value.mtimeMs };
  }
}

const WORKER_LOG_NAMESPACE = '[team-runtime:worker-entry]';
const LOG_TEXT_LIMIT = 240;

type SafeWorkerLogSummary = {
  readonly runId?: string;
  readonly teamId?: string;
  readonly roleId?: string;
  readonly agentId?: string;
  readonly agentCount?: number;
  readonly roleCount?: number;
  readonly pendingHostRequestCount?: number;
};

function serializeError(error: unknown) {
  return error instanceof Error
    ? { message: error.message, name: error.name, stack: error.stack }
    : { message: String(error) };
}

function sanitizeLogText(value: string): string {
  const redacted = value
    .replace(/(api[_-]?key|authorization|token|password|secret)(["'\s:=]+)[^"'\s,}]+/gi, '$1$2[redacted]')
    .replace(/(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{20,})/g, '$1sk-[redacted]');
  return redacted.length <= LOG_TEXT_LIMIT ? redacted : `${redacted.slice(0, LOG_TEXT_LIMIT)}…`;
}

function formatWorkerLogFields(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function safeErrorSummary(error: unknown): { readonly errorName: string; readonly errorMessage: string } {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: sanitizeLogText(error.message) };
  }
  return { errorName: typeof error, errorMessage: sanitizeLogText(String(error)) };
}

function logWorkerInfo(event: string, fields: Record<string, unknown>): void {
  if (isTeamRuntimeDebugLoggingEnabled()) {
    console.info(`${WORKER_LOG_NAMESPACE} ${event} ${formatWorkerLogFields(fields)}`);
  }
}

function logWorkerWarn(event: string, fields: Record<string, unknown>): void {
  if (isTeamRuntimeDebugLoggingEnabled()) {
    console.warn(`${WORKER_LOG_NAMESPACE} ${event} ${formatWorkerLogFields(fields)}`);
  }
}

function logWorkerError(event: string, fields: Record<string, unknown>): void {
  if (isTeamRuntimeDebugLoggingEnabled()) {
    console.error(`${WORKER_LOG_NAMESPACE} ${event} ${formatWorkerLogFields(fields)}`);
  }
}

function readObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeWorkerLogSummary(value: unknown): SafeWorkerLogSummary {
  const record = readObjectRecord(value);
  if (!record) return {};
  const roles = Array.isArray(record.roles) ? record.roles : undefined;
  const agentIds = Array.isArray(record.agentIds) ? record.agentIds : undefined;
  const managedAgents = Array.isArray(record.managedAgents) ? record.managedAgents : undefined;
  return {
    runId: readStringProperty(record, 'runId'),
    teamId: readStringProperty(record, 'teamId'),
    roleId: readStringProperty(record, 'roleId'),
    agentId: readStringProperty(record, 'agentId'),
    ...(agentIds ? { agentCount: agentIds.length } : managedAgents ? { agentCount: managedAgents.length } : {}),
    ...(roles ? { roleCount: roles.length } : {}),
  };
}

if (!parentPort) {
  throw new Error('TeamRuntime worker requires parentPort');
}

const config = workerData as TeamRuntimeWorkerConfig;
const fileSystem = new WorkerRuntimeFileSystem();
const hostRpc = new TeamRuntimeWorkerHostRpc((message) => parentPort!.postMessage(message satisfies TeamRuntimeWorkerToMainMessage));
let outboxStore: SqliteTeamOutboxStore | null = null;
let teamRuntimeService: TeamRuntimeService | null = null;
let outboxPoller: TeamRuntimeOutboxPoller | null = null;
let startupError: unknown = null;

const startup = startWorkerRuntime().catch((error) => {
  startupError = error;
  logWorkerError('startup error', {
    pendingHostRequestCount: hostRpc.pendingCount(),
    ...safeErrorSummary(error),
  });
  parentPort!.postMessage({ type: 'team-runtime.result', requestId: 'team-runtime-worker-startup', ok: false, error: serializeError(error) } satisfies TeamRuntimeWorkerResponse);
});

async function startWorkerRuntime(): Promise<void> {
  const startedAtMs = Date.now();
  logWorkerInfo('startup begin', { shardCount: config.shardCount ?? 1, pendingHostRequestCount: hostRpc.pendingCount() });
  const roleSessions = new WorkerProxyTeamRoleSessionPort(hostRpc);
  const agentMaterialization = new WorkerProxyTeamAgentMaterializationPort(hostRpc);
  const jobs = new WorkerProxyTeamRuntimeJobPort(hostRpc);
  const skillCatalog = new WorkerProxyTeamSkillCatalogPort(hostRpc);
  const databasePath = path.join(config.runtimeDataRootDir, 'team-runtime', 'outbox.sqlite');
  outboxStore = await SqliteTeamOutboxStore.open({
    databasePath,
    ensureDatabaseDirectory: () => mkdir(path.dirname(databasePath), { recursive: true }),
    nowMs: () => Date.now(),
    randomId: () => randomUUID(),
  });
  const ingress = new SqliteTeamIngressAdapter(outboxStore);
  const stateStore = new FileTeamRuntimeStateStore({
    runtimeData: { getRuntimeDataRootDir: () => config.runtimeDataRootDir },
    fileSystem,
  });
  const packageService = new TeamRuntimePackageService({ fileSystem });
  const mailDelivery = new TeamRuntimeMailDeliveryService({
    roleSessions,
    nowMs: () => Date.now(),
  });
  teamRuntimeService = new TeamRuntimeService({
    ingress,
    stateStore,
    packageService,
    skillCatalog,
    agentMaterialization,
    roleSessions,
    mailDelivery,
    jobs,
    nowMs: () => Date.now(),
    randomId: () => randomBytes(16).toString('hex'),
    shardCount: config.shardCount,
  });
  outboxPoller = new TeamRuntimeOutboxPoller({
    runRegistry: teamRuntimeService.runRegistry,
    dirtyRunStore: outboxStore,
    teamRuntimeService,
    nowMs: () => Date.now(),
  });
  await logDeferredDirtyRuns(outboxStore);
  logWorkerInfo('startup ready', {
    durationMs: Date.now() - startedAtMs,
    pendingHostRequestCount: hostRpc.pendingCount(),
  });
}

async function logDeferredDirtyRuns(store: SqliteTeamOutboxStore): Promise<void> {
  if (!isTeamRuntimeDebugLoggingEnabled()) return;
  const dirtyRuns = await store.listDirtyRuns();
  logWorkerInfo('dirty run recovery deferred', {
    count: dirtyRuns.length,
    pendingHostRequestCount: hostRpc.pendingCount(),
  });
}

async function handleInvoke(message: TeamRuntimeWorkerRequest): Promise<void> {
  const startedAtMs = Date.now();
  const safeSummary = safeWorkerLogSummary(message.params);
  logWorkerInfo('invoke receive', {
    requestId: message.requestId,
    operationId: message.operationId,
    pendingHostRequestCount: hostRpc.pendingCount(),
    ...safeSummary,
  });
  try {
    await startup;
    if (startupError) {
      throw startupError;
    }
    if (!teamRuntimeService) {
      throw new Error('TeamRuntime worker failed to initialize');
    }
    const response = await teamRuntimeService.invoke(message.operationId, message.params, message.scope);
    outboxPoller?.refresh();
    logWorkerInfo('invoke success', {
      requestId: message.requestId,
      operationId: message.operationId,
      durationMs: Date.now() - startedAtMs,
      pendingHostRequestCount: hostRpc.pendingCount(),
      ...safeSummary,
    });
    parentPort!.postMessage({ type: 'team-runtime.result', requestId: message.requestId, ok: true, response } satisfies TeamRuntimeWorkerResponse);
  } catch (error) {
    logWorkerError('invoke error', {
      requestId: message.requestId,
      operationId: message.operationId,
      durationMs: Date.now() - startedAtMs,
      pendingHostRequestCount: hostRpc.pendingCount(),
      ...safeSummary,
      ...safeErrorSummary(error),
    });
    parentPort!.postMessage({ type: 'team-runtime.result', requestId: message.requestId, ok: false, error: serializeError(error) } satisfies TeamRuntimeWorkerResponse);
  }
}

parentPort.on('message', (message: TeamRuntimeMainToWorkerMessage) => {
  if (message.type === 'host.result') {
    hostRpc.resolve(message);
    return;
  }
  if (message.type === 'team-runtime.close') {
    const startedAtMs = Date.now();
    logWorkerInfo('close receive', { requestId: message.requestId, pendingHostRequestCount: hostRpc.pendingCount() });
    outboxPoller?.close();
    outboxPoller = null;
    outboxStore?.close();
    logWorkerInfo('close success', {
      requestId: message.requestId,
      durationMs: Date.now() - startedAtMs,
      pendingHostRequestCount: hostRpc.pendingCount(),
    });
    parentPort!.postMessage({ type: 'team-runtime.result', requestId: message.requestId, ok: true, response: { status: 200, data: { success: true } } } satisfies TeamRuntimeWorkerResponse);
    return;
  }
  if (message.type === 'team-runtime.invoke') {
    void handleInvoke(message);
  }
});

parentPort.on('close', () => {
  logWorkerWarn('parent port close', { pendingHostRequestCount: hostRpc.pendingCount() });
  hostRpc.rejectAll(new Error('TeamRuntime worker parent port closed'));
});
