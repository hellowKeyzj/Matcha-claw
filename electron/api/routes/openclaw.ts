import type { IncomingMessage, ServerResponse } from 'http';
import { RuntimeHostControlError, type RuntimeHostControlOutcome } from '../../main/runtime-host-delivery/control';
import type { RuntimeHostApiContext, RuntimeHostTransportContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const ENVIRONMENT_STATUS_UNAVAILABLE = 'OpenClaw environment status is unavailable';
const READINESS_UNAVAILABLE = 'OpenClaw readiness is unavailable';
const DIRECTORY_UNAVAILABLE = 'OpenClaw directory is unavailable';
const CONFIG_DIRECTORY_UNAVAILABLE = 'OpenClaw config directory is unavailable';
const SUBAGENT_TEMPLATES_UNAVAILABLE = 'OpenClaw subagent templates are unavailable';
const SUBAGENT_TEMPLATE_UNAVAILABLE = 'OpenClaw subagent template is unavailable';
const WORKSPACE_DIRECTORY_UNAVAILABLE = 'OpenClaw workspace directory is unavailable';
const TASK_WORKSPACE_DIRECTORIES_UNAVAILABLE = 'OpenClaw task workspace directories are unavailable';
const SKILLS_DIRECTORY_UNAVAILABLE = 'OpenClaw skills directory is unavailable';
const TOOL_PERMISSION_MODE_UNAVAILABLE = 'OpenClaw tool permission mode is unavailable';
const CLI_COMMAND_UNAVAILABLE = 'OpenClaw CLI command is unavailable';
const RUNTIME_SNAPSHOT_UNAVAILABLE = 'OpenClaw runtime snapshot is unavailable';
const LIFECYCLE_UNAVAILABLE = 'OpenClaw lifecycle is unavailable';
const LIFECYCLE_RESTART_FAILED = 'OpenClaw lifecycle restart failed';
const LIFECYCLE_RESTART_UNKNOWN = 'OpenClaw lifecycle restart outcome is unknown';

const SUBAGENT_TEMPLATE_PREFIX = '/api/openclaw/subagent-templates/';
const TEMPLATE_FILE_NAMES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'] as const;
const MAX_TEMPLATE_TEXT_BYTES = 1024 * 1024;

type TemplateFileName = (typeof TEMPLATE_FILE_NAMES)[number];
type RuntimeLifecycle =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'waitingToRestart'
  | 'failed'
  | 'shutDown';
type RuntimeFailure =
  | 'artifactUnavailable'
  | 'permissionDenied'
  | 'resourceUnavailable'
  | 'platformRejected'
  | 'stdio'
  | 'readiness'
  | 'unexpectedExit'
  | 'authorityLost'
  | 'cleanupUnconfirmed'
  | 'materialCleanupFailed';
type RuntimeStartupDiagnostic =
  | 'portConflict'
  | 'configurationRejected'
  | 'appServerReportedError'
  | 'unclassifiedStderr'
  | 'invalidUtf8'
  | 'lineTooLong'
  | 'listenerReported'
  | 'bindRejected'
  | 'startupFailed'
  | 'invalidEncoding'
  | 'diagnosticLimitReached';
type HostLifecycle = 'created' | 'starting' | 'ready' | 'shuttingDown' | 'shutDown';
type ControlPhase = 'ready' | 'starting' | 'unavailable';

type EnvironmentStatus = Readonly<{
  packageExists: boolean;
  isBuilt: boolean;
  dir: string;
  version?: string;
}>;

type TemplateCategory = Readonly<{
  id: string;
  order?: number;
}>;

type TemplateSummary = Readonly<{
  id: string;
  name: string;
  summary?: string;
  categoryId?: string;
  subcategoryId?: string;
  order?: number;
  files: readonly TemplateFileName[];
}>;

type TemplateDetail = Readonly<{
  template: TemplateSummary & Readonly<{
    fileContents: Readonly<Partial<Record<TemplateFileName, string>>>;
  }>;
}>;

type RuntimeStateProjection = Readonly<{
  lifecycle: RuntimeLifecycle;
  observedAtMs?: number;
  failure?: RuntimeFailure;
  startupDiagnostic?: RuntimeStartupDiagnostic;
}>;

type HostState = Readonly<{
  ok: boolean;
  lifecycle: HostLifecycle;
  matcha: RuntimeStateProjection;
  openClaw: RuntimeStateProjection;
}>;

type GatewaySnapshot =
  | Readonly<{ availability: 'unavailable' }>
  | Readonly<{
    availability: 'available';
    ok: boolean;
    timestampMs: number;
    durationMs: number;
    channelCount: number;
    agentCount: number;
    sessionCount: number;
    heartbeatEnabled: boolean | null;
  }>;

type ControlSnapshot = Readonly<{
  ready: boolean;
  phase: ControlPhase;
  retryable: boolean;
}>;

type RuntimeSnapshot = Readonly<{
  state: HostState;
  health: HostState;
  gateway: GatewaySnapshot;
  control: ControlSnapshot;
  observedAtMs: number;
}>;

type LifecycleStatus = Readonly<{
  processState: RuntimeLifecycle;
  failure?: RuntimeFailure;
  startupDiagnostic?: RuntimeStartupDiagnostic;
}>;

type OpenClawToolPermissionMode = 'default' | 'fullAccess';

type RuntimePaths = Readonly<{
  openclawDirectory: string;
  configDirectory: string;
  workspaceDirectory: string;
  taskWorkspaceDirectories: readonly string[];
  skillsDirectory: string;
}>;

type OpenClawApiContext = RuntimeHostApiContext & RuntimeHostTransportContext<
  'runtimeControlTransport' | 'openClawPlatformTransport'
>;

export async function handleOpenClawRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: OpenClawApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/openclaw/status' && req.method === 'GET') {
    await handleEnvironmentStatus(ctx, res);
    return true;
  }

  if (url.pathname === '/api/openclaw/ready' && req.method === 'GET') {
    await handleReadiness(ctx, res);
    return true;
  }

  if (url.pathname === '/api/openclaw/dir' && req.method === 'GET') {
    await handleRuntimePath(ctx, res, 'openclawDirectory', DIRECTORY_UNAVAILABLE);
    return true;
  }

  if (url.pathname === '/api/openclaw/config-dir' && req.method === 'GET') {
    await handleRuntimePath(ctx, res, 'configDirectory', CONFIG_DIRECTORY_UNAVAILABLE);
    return true;
  }

  if (url.pathname === '/api/openclaw/subagent-templates' && req.method === 'GET') {
    await handleTemplateCatalog(ctx, res);
    return true;
  }

  const templateId = readSubagentTemplateId(url.pathname);
  if (req.method === 'GET' && templateId !== undefined) {
    if (templateId === null) {
      sendJson(res, 400, { success: false, error: SUBAGENT_TEMPLATE_UNAVAILABLE });
      return true;
    }
    await handleTemplateDetail(ctx, res, templateId);
    return true;
  }

  if (url.pathname === '/api/openclaw/workspace-dir' && req.method === 'GET') {
    await handleRuntimePath(ctx, res, 'workspaceDirectory', WORKSPACE_DIRECTORY_UNAVAILABLE);
    return true;
  }

  if (url.pathname === '/api/openclaw/task-workspace-dirs' && req.method === 'GET') {
    await handleRuntimePaths(ctx, res);
    return true;
  }

  if (url.pathname === '/api/openclaw/skills-dir' && req.method === 'GET') {
    await handleRuntimePath(ctx, res, 'skillsDirectory', SKILLS_DIRECTORY_UNAVAILABLE);
    return true;
  }

  if (url.pathname === '/api/openclaw/tool-permission-mode' && req.method === 'GET') {
    await handleToolPermissionMode(ctx, res);
    return true;
  }

  if (url.pathname === '/api/openclaw/tool-permission-mode' && req.method === 'PUT') {
    await handleToolPermissionModeUpdate(req, ctx, res);
    return true;
  }

  if (url.pathname === '/api/openclaw/cli-command' && req.method === 'GET') {
    await handleCliCommand(ctx, res);
    return true;
  }

  if (url.pathname === '/api/openclaw/runtime/snapshot' && req.method === 'GET') {
    await handleRuntimeSnapshot(ctx, res);
    return true;
  }

  if (url.pathname === '/api/openclaw/lifecycle/status' && req.method === 'GET') {
    await handleLifecycleStatus(ctx, res);
    return true;
  }

  if (url.pathname === '/api/openclaw/lifecycle/restart' && req.method === 'POST') {
    await handleLifecycleRestart(ctx, res);
    return true;
  }

  return false;
}

async function handleEnvironmentStatus(ctx: OpenClawApiContext, res: ServerResponse): Promise<void> {
  const status = await readEnvironmentStatus(ctx);
  if (!status) {
    sendUnavailable(res, ENVIRONMENT_STATUS_UNAVAILABLE);
    return;
  }
  sendJson(res, 200, status);
}

async function handleReadiness(ctx: OpenClawApiContext, res: ServerResponse): Promise<void> {
  const status = await readEnvironmentStatus(ctx);
  if (!status) {
    sendUnavailable(res, READINESS_UNAVAILABLE);
    return;
  }
  sendJson(res, 200, status.packageExists);
}

async function handleRuntimePath(
  ctx: OpenClawApiContext,
  res: ServerResponse,
  key: Exclude<keyof RuntimePaths, 'taskWorkspaceDirectories'>,
  unavailable: string,
): Promise<void> {
  try {
    const response = await ctx.runtimeHostTransports.openClawPlatformTransport.runtimePaths();
    const paths = response.status === 200 ? readRuntimePaths(response.body) : null;
    if (!paths) {
      sendTransportFailure(res, unavailable, response.status);
      return;
    }
    sendJson(res, 200, paths[key]);
  } catch {
    sendUnavailable(res, unavailable);
  }
}

async function handleRuntimePaths(ctx: OpenClawApiContext, res: ServerResponse): Promise<void> {
  try {
    const response = await ctx.runtimeHostTransports.openClawPlatformTransport.runtimePaths();
    const paths = response.status === 200 ? readRuntimePaths(response.body) : null;
    if (!paths) {
      sendTransportFailure(res, TASK_WORKSPACE_DIRECTORIES_UNAVAILABLE, response.status);
      return;
    }
    sendJson(res, 200, paths.taskWorkspaceDirectories);
  } catch {
    sendUnavailable(res, TASK_WORKSPACE_DIRECTORIES_UNAVAILABLE);
  }
}

async function handleCliCommand(ctx: OpenClawApiContext, res: ServerResponse): Promise<void> {
  try {
    const response = await ctx.runtimeHostTransports.openClawPlatformTransport.cliCommand();
    const command = response.status === 200 ? readCliCommand(response.body) : null;
    if (!command) {
      sendTransportFailure(res, CLI_COMMAND_UNAVAILABLE, response.status);
      return;
    }
    sendJson(res, 200, { success: true, command });
  } catch {
    sendUnavailable(res, CLI_COMMAND_UNAVAILABLE);
  }
}

async function handleToolPermissionMode(
  ctx: OpenClawApiContext,
  res: ServerResponse,
): Promise<void> {
  try {
    const response = await ctx.runtimeHostTransports.openClawPlatformTransport.toolPermissionMode();
    const mode = response.status === 200 ? readToolPermissionMode(response.body) : null;
    if (!mode) {
      sendTransportFailure(res, TOOL_PERMISSION_MODE_UNAVAILABLE, response.status);
      return;
    }
    sendJson(res, 200, { mode });
  } catch {
    sendUnavailable(res, TOOL_PERMISSION_MODE_UNAVAILABLE);
  }
}

async function handleToolPermissionModeUpdate(
  req: IncomingMessage,
  ctx: OpenClawApiContext,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendInvalidToolPermissionMode(res);
    return;
  }
  const mode = readToolPermissionModeInput(body);
  if (!mode) {
    sendInvalidToolPermissionMode(res);
    return;
  }

  try {
    const response = await ctx.runtimeHostTransports.openClawPlatformTransport.setToolPermissionMode({ mode });
    if (response.status === 400) {
      sendInvalidToolPermissionMode(res);
      return;
    }
    const result = response.status === 200 ? readToolPermissionModeUpdate(response.body) : null;
    if (!result) {
      sendTransportFailure(res, TOOL_PERMISSION_MODE_UNAVAILABLE, response.status);
      return;
    }
    sendJson(res, 200, { mode: result.mode });
  } catch {
    sendUnavailable(res, TOOL_PERMISSION_MODE_UNAVAILABLE);
  }
}

async function handleTemplateCatalog(ctx: OpenClawApiContext, res: ServerResponse): Promise<void> {
  try {
    const response = await ctx.runtimeHostTransports.openClawPlatformTransport.subagentTemplateCatalog();
    const catalog = response.status === 200 ? readTemplateCatalog(response.body) : null;
    if (!catalog) {
      sendUnavailable(res, SUBAGENT_TEMPLATES_UNAVAILABLE);
      return;
    }
    sendJson(res, 200, catalog);
  } catch {
    sendUnavailable(res, SUBAGENT_TEMPLATES_UNAVAILABLE);
  }
}

async function handleTemplateDetail(
  ctx: OpenClawApiContext,
  res: ServerResponse,
  templateId: string,
): Promise<void> {
  try {
    const response = await ctx.runtimeHostTransports.openClawPlatformTransport.subagentTemplateDetail({ id: templateId });
    const detail = response.status === 200 ? readTemplateDetail(response.body, templateId) : null;
    if (!detail) {
      sendUnavailable(res, SUBAGENT_TEMPLATE_UNAVAILABLE);
      return;
    }
    sendJson(res, 200, detail);
  } catch {
    sendUnavailable(res, SUBAGENT_TEMPLATE_UNAVAILABLE);
  }
}

async function handleRuntimeSnapshot(ctx: RuntimeHostApiContext, res: ServerResponse): Promise<void> {
  try {
    const snapshot = readRuntimeSnapshot(await ctx.runtimeHost.command({ name: 'host.runtime.snapshot' }));
    if (!snapshot) {
      sendUnavailable(res, RUNTIME_SNAPSHOT_UNAVAILABLE);
      return;
    }
    sendJson(res, 200, snapshot);
  } catch {
    sendUnavailable(res, RUNTIME_SNAPSHOT_UNAVAILABLE);
  }
}

async function handleLifecycleStatus(ctx: OpenClawApiContext, res: ServerResponse): Promise<void> {
  try {
    const response = await ctx.runtimeHostTransports.runtimeControlTransport.lifecycleStatus();
    const status = response.status === 200 ? readLifecycleStatus(response.body) : null;
    if (!status) {
      sendUnavailable(res, LIFECYCLE_UNAVAILABLE);
      return;
    }
    sendJson(res, 200, status);
  } catch {
    sendUnavailable(res, LIFECYCLE_UNAVAILABLE);
  }
}

async function handleLifecycleRestart(ctx: OpenClawApiContext, res: ServerResponse): Promise<void> {
  try {
    const response = await ctx.runtimeHostTransports.runtimeControlTransport.lifecycleRestart();
    if (response.status === 503) {
      sendUnavailable(res, LIFECYCLE_RESTART_UNKNOWN);
      return;
    }
    const status = response.status === 200 ? readLifecycleStatus(response.body) : null;
    if (!status) {
      sendJson(res, 500, { success: false, error: LIFECYCLE_RESTART_FAILED });
      return;
    }
    sendJson(res, 200, { success: true, status });
  } catch (error) {
    const unknown = error instanceof RuntimeHostControlError
      && error.delivery === 'unknown-delivery';
    sendJson(res, unknown ? 503 : 500, {
      success: false,
      error: unknown ? LIFECYCLE_RESTART_UNKNOWN : LIFECYCLE_RESTART_FAILED,
    });
  }
}

function readRuntimePaths(result: unknown): RuntimePaths | null {
  if (!isRecord(result)
    || !hasExactKeys(result, [
      'openclawDirectory',
      'configDirectory',
      'workspaceDirectory',
      'taskWorkspaceDirectories',
      'skillsDirectory',
    ])
    || !isDirectory(result.openclawDirectory)
    || !isDirectory(result.configDirectory)
    || !isDirectory(result.workspaceDirectory)
    || !isDirectory(result.skillsDirectory)
    || !Array.isArray(result.taskWorkspaceDirectories)) {
    return null;
  }
  const taskWorkspaceDirectories: string[] = [];
  for (const directory of result.taskWorkspaceDirectories) {
    if (!isDirectory(directory)) return null;
    taskWorkspaceDirectories.push(directory);
  }
  return {
    openclawDirectory: result.openclawDirectory,
    configDirectory: result.configDirectory,
    workspaceDirectory: result.workspaceDirectory,
    taskWorkspaceDirectories,
    skillsDirectory: result.skillsDirectory,
  };
}

function readCliCommand(result: unknown): string | null {
  return isRecord(result) && hasExactKeys(result, ['command']) && isCliCommand(result.command)
    ? result.command
    : null;
}

function readToolPermissionMode(result: unknown): OpenClawToolPermissionMode | null {
  return isRecord(result) && hasExactKeys(result, ['mode']) && isToolPermissionMode(result.mode)
    ? result.mode
    : null;
}

function readToolPermissionModeUpdate(
  result: unknown,
): Readonly<{ mode: OpenClawToolPermissionMode; changed: boolean }> | null {
  return isRecord(result)
    && hasExactKeys(result, ['mode', 'changed'])
    && isToolPermissionMode(result.mode)
    && typeof result.changed === 'boolean'
    ? { mode: result.mode, changed: result.changed }
    : null;
}

function readToolPermissionModeInput(value: unknown): OpenClawToolPermissionMode | null {
  return isRecord(value) && hasExactKeys(value, ['mode']) && isToolPermissionMode(value.mode)
    ? value.mode
    : null;
}

async function readEnvironmentStatus(ctx: OpenClawApiContext): Promise<EnvironmentStatus | null> {
  try {
    const response = await ctx.runtimeHostTransports.openClawPlatformTransport.environmentStatus();
    return response.status === 200 ? decodeEnvironmentStatus(response.body) : null;
  } catch {
    return null;
  }
}

function decodeEnvironmentStatus(result: unknown): EnvironmentStatus | null {
  if (!isRecord(result)
    || !hasExpectedKeys(result, ['packageExists', 'isBuilt', 'dir'], ['version'])
    || typeof result.packageExists !== 'boolean'
    || typeof result.isBuilt !== 'boolean'
    || !isDirectory(result.dir)
    || (hasOwn(result, 'version') && !isVersion(result.version))) {
    return null;
  }
  return {
    packageExists: result.packageExists,
    isBuilt: result.isBuilt,
    dir: result.dir,
    ...(hasOwn(result, 'version') ? { version: result.version } : {}),
  };
}

function readTemplateCatalog(result: unknown): {
  categories: readonly TemplateCategory[];
  templates: readonly TemplateSummary[];
} | null {
  if (!isRecord(result)
    || !hasExactKeys(result, ['categories', 'templates'])
    || !Array.isArray(result.categories)
    || !Array.isArray(result.templates)) {
    return null;
  }

  const categories: TemplateCategory[] = [];
  for (const value of result.categories) {
    const category = readTemplateCategory(value);
    if (!category) return null;
    categories.push(category);
  }

  const templates: TemplateSummary[] = [];
  const seenTemplateIds = new Set<string>();
  for (const value of result.templates) {
    const template = readTemplateSummary(value);
    if (!template || seenTemplateIds.has(template.id)) return null;
    seenTemplateIds.add(template.id);
    templates.push(template);
  }

  return { categories, templates };
}

function readTemplateDetail(
  result: unknown,
  expectedTemplateId: string,
): TemplateDetail | null {
  if (!isRecord(result) || !hasExactKeys(result, ['template'])) {
    return null;
  }

  const template = readTemplateWithContents(result.template);
  if (!template || template.id !== expectedTemplateId) return null;
  return { template };
}

function readTemplateCategory(value: unknown): TemplateCategory | null {
  if (!isRecord(value)
    || !hasExpectedKeys(value, ['id'], ['order'])
    || !isSafeMetadataId(value.id)
    || (hasOwn(value, 'order') && !isSafeInteger(value.order))) {
    return null;
  }
  return {
    id: value.id,
    ...(hasOwn(value, 'order') ? { order: value.order } : {}),
  };
}

function readTemplateSummary(value: unknown): TemplateSummary | null {
  if (!isRecord(value)
    || !hasExpectedKeys(
      value,
      ['id', 'name', 'files'],
      ['summary', 'categoryId', 'subcategoryId', 'order'],
    )
    || !isTemplateId(value.id)
    || !isBoundedText(value.name)
    || (hasOwn(value, 'summary') && !isBoundedText(value.summary))
    || (hasOwn(value, 'categoryId') && !isSafeMetadataId(value.categoryId))
    || (hasOwn(value, 'subcategoryId') && !isSafeMetadataId(value.subcategoryId))
    || (hasOwn(value, 'order') && !isSafeInteger(value.order))) {
    return null;
  }

  const files = readTemplateFiles(value.files);
  if (!files) return null;
  return {
    id: value.id,
    name: value.name,
    ...(hasOwn(value, 'summary') ? { summary: value.summary } : {}),
    ...(hasOwn(value, 'categoryId') ? { categoryId: value.categoryId } : {}),
    ...(hasOwn(value, 'subcategoryId') ? { subcategoryId: value.subcategoryId } : {}),
    ...(hasOwn(value, 'order') ? { order: value.order } : {}),
    files,
  };
}

function readTemplateWithContents(
  value: unknown,
): (TemplateSummary & Readonly<{ fileContents: Readonly<Partial<Record<TemplateFileName, string>>> }>) | null {
  if (!isRecord(value)
    || !hasExpectedKeys(
      value,
      ['id', 'name', 'files', 'fileContents'],
      ['summary', 'categoryId', 'subcategoryId', 'order'],
    )
    || !isTemplateId(value.id)
    || !isBoundedText(value.name)
    || (hasOwn(value, 'summary') && !isBoundedText(value.summary))
    || (hasOwn(value, 'categoryId') && !isSafeMetadataId(value.categoryId))
    || (hasOwn(value, 'subcategoryId') && !isSafeMetadataId(value.subcategoryId))
    || (hasOwn(value, 'order') && !isSafeInteger(value.order))) {
    return null;
  }

  const files = readTemplateFiles(value.files);
  const fileContents = readTemplateFileContents(value.fileContents);
  if (!files || !fileContents) return null;
  return {
    id: value.id,
    name: value.name,
    ...(hasOwn(value, 'summary') ? { summary: value.summary } : {}),
    ...(hasOwn(value, 'categoryId') ? { categoryId: value.categoryId } : {}),
    ...(hasOwn(value, 'subcategoryId') ? { subcategoryId: value.subcategoryId } : {}),
    ...(hasOwn(value, 'order') ? { order: value.order } : {}),
    files,
    fileContents,
  };
}

function readTemplateFiles(value: unknown): readonly TemplateFileName[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const files: TemplateFileName[] = [];
  const seen = new Set<TemplateFileName>();
  for (const file of value) {
    if (!isTemplateFileName(file) || seen.has(file)) return null;
    seen.add(file);
    files.push(file);
  }
  return files;
}

function readTemplateFileContents(
  value: unknown,
): Readonly<Partial<Record<TemplateFileName, string>>> | null {
  if (!isRecord(value)) return null;
  const contents: Partial<Record<TemplateFileName, string>> = {};
  for (const [file, content] of Object.entries(value)) {
    if (!isTemplateFileName(file) || !isBoundedTemplateText(content)) return null;
    contents[file] = content;
  }
  return contents;
}

function readRuntimeSnapshot(outcome: RuntimeHostControlOutcome): RuntimeSnapshot | null {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) return null;
  const result = outcome.result;
  if (!hasExactKeys(result, ['state', 'health', 'gateway', 'control', 'observedAtMs'])
    || !isSafeNonNegativeInteger(result.observedAtMs)) {
    return null;
  }

  const state = readHostState(result.state);
  const health = readHostState(result.health);
  const gateway = readGatewaySnapshot(result.gateway);
  const control = readControlSnapshot(result.control);
  if (!state || !health || !gateway || !control) return null;
  return { state, health, gateway, control, observedAtMs: result.observedAtMs };
}

function readHostState(value: unknown): HostState | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['ok', 'lifecycle', 'matcha', 'openClaw'])
    || typeof value.ok !== 'boolean'
    || !isHostLifecycle(value.lifecycle)) {
    return null;
  }
  const matcha = readRuntimeStateProjection(value.matcha);
  const openClaw = readRuntimeStateProjection(value.openClaw);
  if (!matcha || !openClaw) return null;
  return { ok: value.ok, lifecycle: value.lifecycle, matcha, openClaw };
}

function readRuntimeStateProjection(value: unknown): RuntimeStateProjection | null {
  if (!isRecord(value)
    || !hasExpectedKeys(value, ['lifecycle'], ['observedAtMs', 'failure', 'startupDiagnostic'])
    || !isRuntimeLifecycle(value.lifecycle)
    || (hasOwn(value, 'observedAtMs') && !isSafeNonNegativeInteger(value.observedAtMs))
    || (hasOwn(value, 'failure') && !isRuntimeFailure(value.failure))
    || (hasOwn(value, 'startupDiagnostic') && !isRuntimeStartupDiagnostic(value.startupDiagnostic))) {
    return null;
  }
  return {
    lifecycle: value.lifecycle,
    ...(hasOwn(value, 'failure') ? { failure: value.failure } : {}),
    ...(hasOwn(value, 'startupDiagnostic') ? { startupDiagnostic: value.startupDiagnostic } : {}),
  };
}

function readGatewaySnapshot(value: unknown): GatewaySnapshot | null {
  if (!isRecord(value) || !hasOwn(value, 'availability')) return null;
  if (value.availability === 'unavailable') {
    return hasExactKeys(value, ['availability']) ? { availability: 'unavailable' } : null;
  }
  if (value.availability !== 'available'
    || !hasExactKeys(value, [
      'availability',
      'ok',
      'timestampMs',
      'durationMs',
      'channelCount',
      'agentCount',
      'sessionCount',
      'heartbeatEnabled',
    ])
    || typeof value.ok !== 'boolean'
    || !isSafeNonNegativeInteger(value.timestampMs)
    || !isSafeNonNegativeInteger(value.durationMs)
    || !isSafeNonNegativeInteger(value.channelCount)
    || !isSafeNonNegativeInteger(value.agentCount)
    || !isSafeNonNegativeInteger(value.sessionCount)
    || (value.heartbeatEnabled !== null && typeof value.heartbeatEnabled !== 'boolean')) {
    return null;
  }
  return {
    availability: 'available',
    ok: value.ok,
    timestampMs: value.timestampMs,
    durationMs: value.durationMs,
    channelCount: value.channelCount,
    agentCount: value.agentCount,
    sessionCount: value.sessionCount,
    heartbeatEnabled: value.heartbeatEnabled,
  };
}

function readControlSnapshot(value: unknown): ControlSnapshot | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['ready', 'phase', 'retryable'])
    || typeof value.ready !== 'boolean'
    || !isControlPhase(value.phase)
    || typeof value.retryable !== 'boolean') {
    return null;
  }
  const valid = value.phase === 'ready'
    ? value.ready && !value.retryable
    : value.phase === 'starting'
      ? !value.ready && value.retryable
      : !value.ready && !value.retryable;
  return valid ? { ready: value.ready, phase: value.phase, retryable: value.retryable } : null;
}

function readLifecycleStatus(body: unknown): LifecycleStatus | null {
  if (!isRecord(body) || !hasExactKeys(body, ['result'])) return null;
  const state = readRuntimeStateProjection(body.result);
  if (!state) return null;
  return {
    processState: state.lifecycle,
    ...(state.failure ? { failure: state.failure } : {}),
    ...(state.startupDiagnostic ? { startupDiagnostic: state.startupDiagnostic } : {}),
  };
}

function readSubagentTemplateId(pathname: string): string | null | undefined {
  if (!pathname.startsWith(SUBAGENT_TEMPLATE_PREFIX)) return undefined;
  const encodedId = pathname.slice(SUBAGENT_TEMPLATE_PREFIX.length);
  if (!encodedId || encodedId.includes('/')) return undefined;

  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return undefined;
  }
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return undefined;
  return isTemplateId(id) ? id : null;
}

function sendUnavailable(res: ServerResponse, error: string): void {
  sendJson(res, 503, { success: false, error });
}

function sendTransportFailure(res: ServerResponse, unavailable: string, status: number): void {
  sendJson(res, status === 400 ? 400 : status === 500 ? 500 : 503, {
    success: false,
    error: unavailable,
  });
}

function sendInvalidToolPermissionMode(res: ServerResponse): void {
  sendJson(res, 400, {
    success: false,
    error: 'permission mode must be "default" or "fullAccess"',
  });
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9A-Za-z.+-]+$/.test(value)
    && Buffer.byteLength(value, 'utf8') <= 128;
}

function isDirectory(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !/[\p{Cc}]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= 16 * 1024;
}

function isCliCommand(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !/[\p{Cc}]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= 16 * 1024;
}

function isToolPermissionMode(value: unknown): value is OpenClawToolPermissionMode {
  return value === 'default' || value === 'fullAccess';
}

function isTemplateId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,128}$/.test(value);
}

function isSafeMetadataId(value: unknown): value is string {
  return isBoundedText(value, 128)
    && !value.includes('\\')
    && !value.includes('\0');
}

function isBoundedText(value: unknown, maxBytes = 16 * 1024): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isBoundedTemplateText(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_TEMPLATE_TEXT_BYTES;
}

function isTemplateFileName(value: unknown): value is TemplateFileName {
  return typeof value === 'string' && TEMPLATE_FILE_NAMES.includes(value as TemplateFileName);
}

function isRuntimeLifecycle(value: unknown): value is RuntimeLifecycle {
  return value === 'unavailable'
    || value === 'idle'
    || value === 'starting'
    || value === 'running'
    || value === 'stopping'
    || value === 'waitingToRestart'
    || value === 'failed'
    || value === 'shutDown';
}

function isRuntimeFailure(value: unknown): value is RuntimeFailure {
  return value === 'artifactUnavailable'
    || value === 'permissionDenied'
    || value === 'resourceUnavailable'
    || value === 'platformRejected'
    || value === 'stdio'
    || value === 'readiness'
    || value === 'unexpectedExit'
    || value === 'authorityLost'
    || value === 'cleanupUnconfirmed'
    || value === 'materialCleanupFailed';
}

function isRuntimeStartupDiagnostic(value: unknown): value is RuntimeStartupDiagnostic {
  return value === 'portConflict'
    || value === 'configurationRejected'
    || value === 'appServerReportedError'
    || value === 'unclassifiedStderr'
    || value === 'invalidUtf8'
    || value === 'lineTooLong'
    || value === 'listenerReported'
    || value === 'bindRejected'
    || value === 'startupFailed'
    || value === 'invalidEncoding'
    || value === 'diagnosticLimitReached';
}

function isHostLifecycle(value: unknown): value is HostLifecycle {
  return value === 'created'
    || value === 'starting'
    || value === 'ready'
    || value === 'shuttingDown'
    || value === 'shutDown';
}

function isControlPhase(value: unknown): value is ControlPhase {
  return value === 'ready' || value === 'starting' || value === 'unavailable';
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExpectedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return required.every((key) => hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => hasOwn(value, key));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
