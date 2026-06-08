import type { WorkspaceFileRuntimeWorkflow } from '../workflows/workspace-file/workspace-file-runtime-workflow';

export interface FileRuntimeDataStorePort {
  getRuntimeDataRootDir(): string;
}

interface FileServiceDeps {
  runtimeWorkflow: Pick<
    WorkspaceFileRuntimeWorkflow,
    | 'readText'
    | 'writeText'
    | 'readBinary'
    | 'stat'
    | 'listDir'
    | 'stagePaths'
    | 'stageBuffer'
    | 'thumbnail'
    | 'thumbnails'
  >;
}

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  async readText(payload: unknown) {
    return await this.deps.runtimeWorkflow.readText(payload);
  }

  async writeText(payload: unknown) {
    return await this.deps.runtimeWorkflow.writeText(payload);
  }

  async readBinary(payload: unknown) {
    return await this.deps.runtimeWorkflow.readBinary(payload);
  }

  async stat(payload: unknown) {
    return await this.deps.runtimeWorkflow.stat(payload);
  }

  async listDir(payload: unknown) {
    return await this.deps.runtimeWorkflow.listDir(payload);
  }

  async stagePaths(payload: unknown) {
    return await this.deps.runtimeWorkflow.stagePaths(payload);
  }

  async stageBuffer(payload: unknown) {
    return await this.deps.runtimeWorkflow.stageBuffer(payload);
  }

  async thumbnail(payload: unknown) {
    return await this.deps.runtimeWorkflow.thumbnail(payload);
  }

  async thumbnails(payload: unknown) {
    return await this.deps.runtimeWorkflow.thumbnails(payload);
  }
}
