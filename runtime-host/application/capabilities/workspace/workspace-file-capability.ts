import { ok } from '../../common/application-response';
import type { FileService } from '../../files/file-service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const WORKSPACE_FILE_CAPABILITY_ID = 'workspace.file';

export const workspaceFileCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'files.readText', title: 'Read text file' },
  { id: 'files.readBinary', title: 'Read binary file' },
  { id: 'files.stat', title: 'Stat file' },
  { id: 'files.listDir', title: 'List directory' },
  { id: 'files.writeText', title: 'Write text file' },
  { id: 'files.stagePaths', title: 'Stage file paths' },
  { id: 'files.stageBuffer', title: 'Stage file buffer' },
] as const;

export function createWorkspaceFileCapabilityOperationRoutes(deps: {
  fileService: Pick<FileService, 'readText' | 'readBinary' | 'stat' | 'listDir' | 'writeText' | 'stagePaths' | 'stageBuffer'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.readText',
      handle: async (context) => ok(await deps.fileService.readText(context.domainInput)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.readBinary',
      handle: async (context) => ok(await deps.fileService.readBinary(context.domainInput)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.stat',
      handle: async (context) => ok(await deps.fileService.stat(context.domainInput)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.listDir',
      handle: async (context) => ok(await deps.fileService.listDir(context.domainInput)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.writeText',
      handle: async (context) => ok(await deps.fileService.writeText(context.domainInput)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.stagePaths',
      handle: async (context) => ok(await deps.fileService.stagePaths(context.domainInput)),
    },
    {
      capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
      operationId: 'files.stageBuffer',
      handle: async (context) => ok(await deps.fileService.stageBuffer(context.domainInput)),
    },
  ];
}

