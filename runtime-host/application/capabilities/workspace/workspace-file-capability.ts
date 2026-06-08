import { runtimeEndpointsEqual, validateSessionIdentity, type RuntimeScope, type SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import { badRequest, ok } from '../../common/application-response';
import type { FileService } from '../../files/file-service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationContext, CapabilityOperationRoute } from '../contracts/capability-router';

export const WORKSPACE_FILE_CAPABILITY_ID = 'workspace.file';

export const workspaceFileCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'files.readText', title: 'Read text file', targetKind: 'workspace-file' },
  { id: 'files.readBinary', title: 'Read binary file', targetKind: 'workspace-file' },
  { id: 'files.stat', title: 'Stat file', targetKind: 'workspace-file' },
  { id: 'files.listDir', title: 'List directory', targetKind: 'workspace-file' },
  { id: 'files.writeText', title: 'Write text file', targetKind: 'workspace-file' },
  { id: 'files.thumbnail', title: 'Generate file thumbnail', targetKind: 'workspace-file' },
  { id: 'files.stagePaths', title: 'Stage file paths', targetKind: 'workspace-staging' },
  { id: 'files.stageBuffer', title: 'Stage file buffer', targetKind: 'workspace-staging' },
] as const;

function workspaceMetadataMatches(scope: RuntimeScope, target: { workspaceId?: string; sourceId?: string }): boolean {
  if (scope.kind !== 'workspace') {
    return false;
  }
  return target.workspaceId === scope.workspaceId
    && target.sourceId === scope.sourceId;
}

function workspaceIdentityMatches(scope: RuntimeScope, target: { identity?: unknown }): boolean {
  if (scope.kind !== 'workspace' || validateSessionIdentity(target.identity)) {
    return false;
  }
  return runtimeEndpointsEqual(scope.endpoint, (target.identity as SessionIdentity).endpoint);
}

function withScopeTarget(context: CapabilityOperationContext): Record<string, unknown> {
  return {
    ...context.domainInput,
    scope: context.scope,
    target: context.target,
  };
}

function workspaceFileInput(context: CapabilityOperationContext): Record<string, unknown> | string {
  if (context.target?.kind !== 'workspace-file') {
    return 'Workspace file target is required';
  }
  const inputPath = typeof context.domainInput.path === 'string' ? context.domainInput.path : '';
  if (!inputPath || inputPath !== context.target.path) {
    return 'Workspace file target path must match input path';
  }
  if (!workspaceMetadataMatches(context.scope, context.target)) {
    return 'Workspace file target does not match workspace scope';
  }
  if (!workspaceIdentityMatches(context.scope, context.target)) {
    return 'Workspace file target identity does not match workspace scope';
  }
  return withScopeTarget(context);
}

function workspaceStagingInput(context: CapabilityOperationContext): Record<string, unknown> | string {
  if (context.target?.kind !== 'workspace-staging') {
    return 'Workspace staging target is required';
  }
  if (context.scope.kind !== 'workspace') {
    return 'Workspace scope is required';
  }
  if (!workspaceIdentityMatches(context.scope, context.target)) {
    return 'Workspace staging target identity does not match workspace scope';
  }
  return withScopeTarget(context);
}

async function handleWorkspaceFile(
  context: CapabilityOperationContext,
  operation: (payload: Record<string, unknown>) => Promise<unknown>,
) {
  const input = workspaceFileInput(context);
  return typeof input === 'string' ? badRequest(input) : ok(await operation(input));
}

async function handleWorkspaceStaging(
  context: CapabilityOperationContext,
  operation: (payload: Record<string, unknown>) => Promise<unknown>,
) {
  const input = workspaceStagingInput(context);
  return typeof input === 'string' ? badRequest(input) : ok(await operation(input));
}

export function createWorkspaceFileCapabilityOperationRoutes(deps: {
  fileService: Pick<FileService, 'readText' | 'readBinary' | 'stat' | 'listDir' | 'writeText' | 'thumbnail' | 'stagePaths' | 'stageBuffer'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.readText',
      handle: (context) => handleWorkspaceFile(context, (payload) => deps.fileService.readText(payload)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.readBinary',
      handle: (context) => handleWorkspaceFile(context, (payload) => deps.fileService.readBinary(payload)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.stat',
      handle: (context) => handleWorkspaceFile(context, (payload) => deps.fileService.stat(payload)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.listDir',
      handle: (context) => handleWorkspaceFile(context, (payload) => deps.fileService.listDir(payload)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.writeText',
      handle: (context) => handleWorkspaceFile(context, (payload) => deps.fileService.writeText(payload)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.thumbnail',
      handle: (context) => handleWorkspaceFile(context, (payload) => deps.fileService.thumbnail(payload)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.stagePaths',
      handle: (context) => handleWorkspaceStaging(context, (payload) => deps.fileService.stagePaths(payload)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.stageBuffer',
      handle: (context) => handleWorkspaceStaging(context, (payload) => deps.fileService.stageBuffer(payload)),
    },
  ];
}

