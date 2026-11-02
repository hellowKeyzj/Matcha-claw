import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppPluginBuild, AppPluginDevelopment, AppPluginManifest, InstalledAppPlugin } from '../../../src/types/desktop/app-plugin';
import type { AppRuntimeEvent, AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import { AppPluginRuntimeStartupError, type AppPluginDevelopmentRuntime, type AppPluginHost } from './host';
import type { ApplicationPluginOwner } from './owner';
import { AppPluginError, MAX_APP_PLUGIN_ZIP_BYTES, requireDigest, requireObject } from './package';
import type { PackageResults } from './package-contract';

const MAX_DEVELOPMENTS = 128;
const MAX_LOGS = 128;
const MAX_EVENTS = 32;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OBSERVATION_BYTES = 256 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;

type DevelopmentLogLevel = 'debug' | 'info' | 'warn' | 'error';
type DevelopmentState = 'active' | 'installed' | 'stopped';

export type AppPluginDevelopmentAction = { type: 'click' | 'fill'; id: string; value?: string };
export type AppPluginDevelopmentCommand = { id: string; revision: number; entry: string } & (
  | { kind: 'inspect' }
  | { kind: 'act'; action: AppPluginDevelopmentAction }
);

export interface AppPluginDevelopmentStatus extends AppPluginDevelopment {
  state: DevelopmentState;
  revision?: number;
  manifest?: AppPluginManifest;
  digest?: string;
  backendState: 'not-started' | 'ready' | 'error';
  logs: { seq: number; at: string; level: DevelopmentLogLevel; message: string; revision?: number }[];
  events: { seq: number; revision: number; topic: string; data: unknown }[];
  commands: AppPluginDevelopmentCommand[];
  error?: string;
  installed?: InstalledAppPlugin;
}

interface DevelopmentRun {
  revision: number;
  manifest: AppPluginManifest;
  digest: string;
  bytes?: Uint8Array;
  files?: ReadonlyMap<string, Uint8Array>;
  packagePath?: string;
  runtime?: AppPluginDevelopmentRuntime;
  controller: AbortController;
  backendState: AppPluginDevelopmentStatus['backendState'];
}

interface DevelopmentInstance {
  development: AppPluginDevelopment;
  state: DevelopmentState;
  token?: string;
  boundId?: string;
  run?: DevelopmentRun;
  operation?: Promise<unknown>;
  stopping?: Promise<void>;
  command?: { value: AppPluginDevelopmentCommand; finish(result?: unknown, error?: unknown): void };
  sequence: number;
  logs: AppPluginDevelopmentStatus['logs'];
  events: AppPluginDevelopmentStatus['events'];
  error?: string;
  installed?: InstalledAppPlugin;
}

function cloneJson(value: unknown, maximum: number): unknown {
  if (value === undefined) return undefined;
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { /* Rejected below, without echoing private input. */ }
  if (json === undefined || Buffer.byteLength(json, 'utf8') > maximum) {
    throw new AppPluginError('invalid_package', 'Development observations must be bounded JSON values.');
  }
  return JSON.parse(json) as unknown;
}

function safeMessage(instance: DevelopmentInstance, value: string): string {
  let message = value.slice(0, 8000);
  if (instance.token) message = message.replaceAll(instance.token, '[redacted]');
  return message.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]').slice(0, 2000);
}

export class AppPluginDevelopmentOwner {
  private readonly instances = new Map<string, DevelopmentInstance>();
  private closed = false;
  private closing?: Promise<void>;
  private forcing?: Promise<void>;

  constructor(private readonly options: { root: string; owner: ApplicationPluginOwner; host: AppPluginHost }) {}

  create(): AppPluginDevelopment {
    if (this.closed) throw new AppPluginError('closed', 'Plugin development is closing.');
    if (this.instances.size >= MAX_DEVELOPMENTS) {
      const retired = [...this.instances.values()].find((instance) => instance.state !== 'active' && !instance.operation && !instance.stopping && !instance.run?.packagePath && !instance.run?.runtime);
      if (retired) this.instances.delete(retired.development.developmentId);
    }
    if (this.instances.size >= MAX_DEVELOPMENTS) throw new AppPluginError('busy', 'Too many plugin development instances. Stop an existing instance first.');
    const development: AppPluginDevelopment = { developmentId: randomUUID() };
    this.instances.set(development.developmentId, {
      development, state: 'active', token: randomBytes(32).toString('hex'), sequence: 0, logs: [], events: [],
    });
    return structuredClone(development);
  }

  credentials(developmentId: string): AppPluginDevelopment & { token: string } {
    const instance = this.requireActive(developmentId);
    return { ...structuredClone(instance.development), token: instance.token! };
  }

  authorize(developmentId: string, token: string): void {
    const instance = this.requireActive(developmentId);
    const presented = Buffer.from(typeof token === 'string' && token.length === 64 ? token : '');
    const expected = Buffer.from(instance.token!);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new AppPluginError('conflict', 'Plugin development authorization failed.');
    }
  }

  list(): Pick<AppPluginDevelopmentStatus, 'developmentId' | 'state' | 'revision' | 'manifest' | 'digest'>[] {
    return [...this.instances.values()].map(({ development, state, run }) => structuredClone({
      ...development, state,
      ...(run ? { revision: run.revision, manifest: run.manifest, digest: run.digest } : {}),
    }));
  }

  status(developmentId: string): AppPluginDevelopmentStatus {
    const instance = this.requireInstance(developmentId);
    const run = instance.run;
    return structuredClone({
      ...instance.development, state: instance.state,
      ...(run ? { revision: run.revision, manifest: run.manifest, digest: run.digest } : {}),
      backendState: run?.backendState ?? 'not-started',
      logs: instance.logs, events: instance.events, commands: instance.command ? [instance.command.value] : [],
      ...(instance.error ? { error: instance.error } : {}),
      ...(instance.installed ? { installed: instance.installed } : {}),
    });
  }

  upload(developmentId: string, bytes: Uint8Array): Promise<AppPluginDevelopmentStatus> {
    return this.withInstance(developmentId, async (instance) => {
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_APP_PLUGIN_ZIP_BYTES) {
        throw new AppPluginError('invalid_package', 'Development upload requires a bounded ZIP package.');
      }
      // Package worker transfers its input; keep caller and accepted ZIP snapshots independently owned.
      const contents = await this.options.owner.validate(new Uint8Array(bytes));
      await this.replace(instance, contents);
      return this.status(developmentId);
    });
  }

  build(developmentId: string, input: { manifest: AppPluginManifest; files: Record<string, string> }): Promise<AppPluginBuild> {
    return this.withInstance(developmentId, async (instance) => {
      const build = await this.options.owner.build(input);
      const contents = await this.options.owner.validate(new Uint8Array(Buffer.from(build.packageBase64, 'base64')));
      if (contents.digest !== build.digest) throw new Error('Development build digest does not match its validated ZIP.');
      await this.replace(instance, contents);
      return build;
    });
  }

  install(developmentId: string, input: { digest: string }): Promise<InstalledAppPlugin> {
    return this.withInstance(developmentId, async (instance) => {
      const value = requireObject(input, ['digest']);
      requireDigest(value.digest);
      const run = this.requireRun(instance);
      if (!run.bytes || value.digest !== run.digest) {
        throw new AppPluginError('conflict', 'Install requires the digest of the latest successful development build or ZIP upload.');
      }
      this.rejectCommand(instance, new AppPluginError('closed', 'The development package is being installed.'));
      await this.stopRun(instance, run);
      this.requireActive(developmentId);
      let installed: InstalledAppPlugin;
      try {
        // Only the retained validated ZIP is authoritative, never a package echoed by a model.
        installed = await this.options.owner.importBytes({ bytes: new Uint8Array(run.bytes), digest: run.digest, origin: 'agent', onlyIfNew: true });
      } catch (error) {
        let committed: InstalledAppPlugin | undefined;
        try { committed = (await this.options.owner.list()).plugins.find((plugin) => plugin.manifest.id === run.manifest.id && plugin.digest === run.digest); }
        catch {
          this.terminate(instance, 'stopped');
          this.recordError(instance, new Error('The installation outcome could not be verified. Refresh installed plugins before starting another development instance.'));
          void this.stopInstance(instance).catch((cleanupError: unknown) => this.recordError(instance, cleanupError));
          throw error;
        }
        if (!committed) throw error;
        installed = committed;
        this.recordError(instance, error);
      }
      instance.installed = structuredClone(installed);
      this.terminate(instance, 'installed');
      try { await this.removeTemporaryData(instance); } catch (error) { this.recordError(instance, error); }
      return structuredClone(installed);
    });
  }

  bundle(input: { developmentId: string; revision: number; entry: string }): { html: string } {
    const value = requireObject(input, ['developmentId', 'revision', 'entry']);
    const instance = this.requireActive(value.developmentId as string);
    const run = this.requireRun(instance, value.revision, true);
    const declared = run.manifest.contributes.applications?.some((entry) => entry.entry === value.entry)
      || run.manifest.contributes.readers?.some((entry) => entry.entry === value.entry);
    if (typeof value.entry !== 'string' || !declared) throw new AppPluginError('invalid_package', 'The preview HTML entry is not declared by this revision.');
    const bytes = run.files?.get(value.entry);
    if (!bytes) throw new AppPluginError('not_found', 'The development HTML entry is unavailable.');
    return { html: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8') };
  }

  call(input: { developmentId: string; revision?: number; name: string; arguments: Record<string, unknown> }, signal: AbortSignal): Promise<AppToolResult> {
    const value = requireObject(input, ['developmentId', 'revision', 'name', 'arguments']);
    return this.withInstance(value.developmentId as string, async (instance) => {
      const run = this.requireRun(instance, value.revision);
      if (typeof value.name !== 'string' || !run.manifest.contributes.tools?.some((tool) => tool.name === value.name)
        || !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) {
        throw new AppPluginError('invalid_package', 'Development calls require a declared local tool and object arguments.');
      }
      if (run.backendState !== 'ready' || !run.runtime) throw new AppPluginError('conflict', 'This development revision has no ready backend. Upload a corrected build before calling it.');
      const combined = AbortSignal.any([signal, run.controller.signal]);
      combined.throwIfAborted();
      return run.runtime.call(value.name, value.arguments as Record<string, unknown>, combined);
    });
  }

  observe(input: { developmentId: string; revision: number; commandId: string; result?: unknown; error?: string }): void {
    const value = requireObject(input, ['developmentId', 'revision', 'commandId', 'result', 'error']);
    const instance = this.requireActive(value.developmentId as string);
    this.requireRun(instance, value.revision, true);
    const command = instance.command;
    if (!command || command.value.id !== value.commandId || command.value.revision !== value.revision) {
      throw new AppPluginError('conflict', 'The development preview command is no longer pending.');
    }
    if (value.error !== undefined && (typeof value.error !== 'string' || !value.error.length || value.error.length > 2000)) {
      throw new AppPluginError('invalid_package', 'Invalid development preview error.');
    }
    const result = cloneJson(value.result, MAX_OBSERVATION_BYTES);
    command.finish(result, value.error === undefined ? undefined : new Error(safeMessage(instance, value.error as string)));
  }

  log(input: { developmentId: string; revision: number; level: DevelopmentLogLevel; message: string }): void {
    const value = requireObject(input, ['developmentId', 'revision', 'level', 'message']);
    const instance = this.requireActive(value.developmentId as string);
    const run = this.requireRun(instance, value.revision, true);
    if (!['debug', 'info', 'warn', 'error'].includes(value.level as string) || typeof value.message !== 'string' || value.message.length > 8000) {
      throw new AppPluginError('invalid_package', 'Invalid development log entry.');
    }
    this.appendLog(instance, value.level as DevelopmentLogLevel, value.message, run.revision);
  }

  inspect(developmentId: string, signal: AbortSignal, entry?: string): Promise<unknown> {
    return this.requestObservation(developmentId, { kind: 'inspect' }, signal, entry);
  }

  act(developmentId: string, action: AppPluginDevelopmentAction, signal: AbortSignal, entry?: string): Promise<unknown> {
    const value = requireObject(action, ['type', 'id', 'value']);
    if ((value.type !== 'click' && value.type !== 'fill') || typeof value.id !== 'string' || !value.id.length || value.id.length > 128
      || (value.value !== undefined && (typeof value.value !== 'string' || value.value.length > 10_000))
      || (value.type === 'fill' && typeof value.value !== 'string')) {
      throw new AppPluginError('invalid_package', 'Development actions require click or fill and an observed node identifier.');
    }
    return this.requestObservation(developmentId, { kind: 'act', action: structuredClone(action) }, signal, entry);
  }

  stop(developmentId: string): Promise<void> {
    const instance = this.requireInstance(developmentId);
    if (instance.state === 'active') this.terminate(instance, 'stopped');
    return this.stopInstance(instance);
  }

  close(): Promise<void> {
    this.closed = true;
    for (const instance of this.instances.values()) if (instance.state === 'active') this.terminate(instance, 'stopped');
    this.closing ??= this.stopAll(false);
    return this.closing;
  }

  forceClose(): Promise<void> {
    this.closed = true;
    for (const instance of this.instances.values()) if (instance.state === 'active') this.terminate(instance, 'stopped');
    this.forcing ??= this.stopAll(true).finally(() => { this.forcing = undefined; });
    return this.forcing;
  }

  private requireInstance(developmentId: string): DevelopmentInstance {
    const instance = typeof developmentId === 'string' ? this.instances.get(developmentId) : undefined;
    if (!instance) throw new AppPluginError('not_found', 'The plugin development instance does not exist.');
    return instance;
  }

  private requireActive(developmentId: string): DevelopmentInstance {
    const instance = this.requireInstance(developmentId);
    if (this.closed || instance.state !== 'active' || !instance.token) {
      throw new AppPluginError('conflict', 'The plugin development instance was stopped or installed.');
    }
    return instance;
  }

  private requireRun(instance: DevelopmentInstance, revision?: unknown, requireRevision = false): DevelopmentRun {
    const run = instance.run;
    if (!run) throw new AppPluginError('not_found', 'Upload or build a valid package before previewing this development instance.');
    if ((requireRevision || revision !== undefined) && (!Number.isSafeInteger(revision) || revision !== run.revision)) {
      throw new AppPluginError('conflict', 'The development revision has changed. Read the latest development status.');
    }
    return run;
  }

  private withInstance<T>(developmentId: string, action: (instance: DevelopmentInstance) => Promise<T>): Promise<T> {
    const instance = this.requireActive(developmentId);
    if (instance.operation) throw new AppPluginError('busy', 'Another operation is using this development instance.');
    const operation = Promise.resolve().then(() => {
      this.requireActive(developmentId);
      return action(instance);
    }).catch((error: unknown) => {
      this.recordError(instance, error);
      throw error;
    }).finally(() => { instance.operation = undefined; });
    instance.operation = operation;
    return operation;
  }

  private async replace(instance: DevelopmentInstance, contents: PackageResults['validate']): Promise<void> {
    this.requireActive(instance.development.developmentId);
    if (instance.boundId && instance.boundId !== contents.manifest.id) throw new AppPluginError('conflict', 'This development instance is bound to a different plugin identifier.');
    if ((await this.options.owner.list()).plugins.some((plugin) => plugin.manifest.id === contents.manifest.id)) {
      throw new AppPluginError('conflict', 'New plugin development cannot replace an installed package. Choose a new identifier.');
    }
    this.requireActive(instance.development.developmentId);
    instance.boundId ??= contents.manifest.id;
    if (instance.run) await this.stopRun(instance, instance.run);
    this.requireActive(instance.development.developmentId);
    this.rejectCommand(instance, new AppPluginError('conflict', 'The development revision has changed.'));
    const run: DevelopmentRun = {
      revision: (instance.run?.revision ?? 0) + 1, manifest: contents.manifest, digest: contents.digest,
      bytes: contents.bytes, files: contents.files, backendState: 'not-started', controller: new AbortController(),
    };
    instance.run = run;
    instance.events = [];
    instance.error = undefined;
    try {
      const runsPath = join(this.directory(instance), 'runs');
      await mkdir(runsPath, { recursive: true, mode: 0o700 });
      run.packagePath = await mkdtemp(join(runsPath, `${run.revision}-`));
      for (const [name, bytes] of contents.files) {
        const path = join(run.packagePath, name);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const executable = run.manifest.backend?.language === 'rust' && run.manifest.backend.entry === name;
        await writeFile(path, bytes, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
      }
      const storagePath = join(this.directory(instance), 'data');
      await mkdir(storagePath, { recursive: true, mode: 0o700 });
      this.requireActive(instance.development.developmentId);
      if (run.manifest.main || run.manifest.backend) {
        run.runtime = await this.options.host.createDevelopment({ manifest: run.manifest, digest: run.digest, packagePath: run.packagePath, storagePath }, {
          publish: (event) => this.publish(instance, run, event),
          log: (level, message) => {
            if (instance.run === run && instance.state === 'active') this.appendLog(instance, level, message, run.revision);
          },
          failed: (error) => {
            if (instance.run !== run || instance.state !== 'active' || run.controller.signal.aborted) return;
            run.backendState = 'error';
            this.recordError(instance, error);
          },
        });
        this.requireActive(instance.development.developmentId);
        if (run.backendState !== 'error') run.backendState = 'ready';
      }
    } catch (error) {
      if (error instanceof AppPluginRuntimeStartupError) run.runtime = error.runtime;
      run.backendState = 'error';
      this.recordError(instance, error);
      if (instance.state !== 'active') throw error;
    }
  }

  private publish(instance: DevelopmentInstance, run: DevelopmentRun, event: AppRuntimeEvent): void {
    if (instance.run !== run || instance.state !== 'active' || event.pluginId !== run.manifest.id || event.digest !== run.digest) return;
    if (typeof event.topic !== 'string' || !event.topic.length || event.topic.length > 200) return;
    try {
      const data = cloneJson(event.data, MAX_EVENT_BYTES);
      instance.events.push({ seq: ++instance.sequence, revision: run.revision, topic: event.topic, data });
      if (instance.events.length > MAX_EVENTS) instance.events.shift();
    } catch (error) { this.recordError(instance, error); }
  }

  private requestObservation(developmentId: string, input: { kind: 'inspect' } | { kind: 'act'; action: AppPluginDevelopmentAction }, signal: AbortSignal, entry?: string): Promise<unknown> {
    const instance = this.requireActive(developmentId);
    if (instance.operation) throw new AppPluginError('busy', 'Another operation is using this development instance.');
    const run = this.requireRun(instance);
    const entries = run.manifest.contributes.applications?.map((application) => application.entry) ?? [];
    const selected = entry ?? (entries.length === 1 ? entries[0] : undefined);
    if (!selected || !entries.includes(selected)) throw new AppPluginError('invalid_package', 'Select one declared application HTML entry for development inspection or interaction.');
    if (instance.command) throw new AppPluginError('busy', 'A development preview command is already pending.');
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(undefined, new Error('The development preview did not respond within 10 seconds. Open the preview and try again.')), COMMAND_TIMEOUT_MS);
      const abort = () => finish(undefined, signal.reason ?? new Error('Development preview command cancelled.'));
      const finish = (result?: unknown, error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (instance.command?.finish !== finish) return;
        instance.command = undefined;
        if (error !== undefined) { this.recordError(instance, error); reject(error); }
        else resolve(result);
      };
      instance.command = { value: { id: randomUUID(), revision: run.revision, entry: selected, ...input }, finish };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private rejectCommand(instance: DevelopmentInstance, error: unknown): void {
    instance.command?.finish(undefined, error);
  }

  private appendLog(instance: DevelopmentInstance, level: DevelopmentLogLevel, message: string, revision?: number): void {
    instance.logs.push({ seq: ++instance.sequence, at: new Date().toISOString(), level, message: safeMessage(instance, message), ...(revision === undefined ? {} : { revision }) });
    if (instance.logs.length > MAX_LOGS) instance.logs.shift();
  }

  private recordError(instance: DevelopmentInstance, error: unknown): void {
    instance.error = safeMessage(instance, error instanceof Error ? error.message : 'Plugin development operation failed; external effects may already have occurred.');
    this.appendLog(instance, 'error', instance.error, instance.run?.revision);
  }

  private terminate(instance: DevelopmentInstance, state: Exclude<DevelopmentState, 'active'>): void {
    instance.token = undefined;
    instance.state = state;
    const error = new AppPluginError('closed', state === 'installed' ? 'The development package was installed.' : 'The development instance is closed.');
    this.rejectCommand(instance, error);
    instance.run?.controller.abort(error);
  }

  private async stopRun(instance: DevelopmentInstance, run: DevelopmentRun, force = false): Promise<void> {
    run.controller.abort(new AppPluginError('closed', 'The development run is stopping.'));
    try {
      if (run.runtime) {
        if (force) await run.runtime.forceClose();
        else await run.runtime.close();
        run.runtime = undefined;
      }
      if (run.packagePath) {
        await rm(run.packagePath, { recursive: true, force: true });
        run.packagePath = undefined;
      }
      if (run.backendState === 'ready') run.backendState = 'not-started';
    } catch (error) {
      run.backendState = 'error';
      this.recordError(instance, error);
      throw error;
    }
  }

  private directory(instance: DevelopmentInstance): string {
    return join(this.options.root, 'development', instance.development.developmentId);
  }

  private async removeTemporaryData(instance: DevelopmentInstance): Promise<void> {
    await rm(this.directory(instance), { recursive: true, force: true });
    if (instance.run) {
      instance.run.bytes = undefined;
      instance.run.files = undefined;
    }
    instance.events = [];
  }

  private stopInstance(instance: DevelopmentInstance, force = false): Promise<void> {
    instance.stopping ??= (async () => {
      await instance.operation?.catch(() => undefined);
      if (instance.run) await this.stopRun(instance, instance.run, force);
      await this.removeTemporaryData(instance);
    })().finally(() => { instance.stopping = undefined; });
    return instance.stopping;
  }

  private async stopAll(force: boolean): Promise<void> {
    const outcomes = await Promise.allSettled([...this.instances.values()].map(async (instance) => {
      if (force && instance.run?.runtime) await instance.run.runtime.forceClose();
      if (force && instance.stopping) await instance.stopping.catch(() => undefined);
      await this.stopInstance(instance, force);
    }));
    const errors = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason as unknown);
    if (errors.length) throw new AggregateError(errors, 'Plugin development cleanup failed; temporary directories were retained until process exit can be confirmed.');
  }
}
