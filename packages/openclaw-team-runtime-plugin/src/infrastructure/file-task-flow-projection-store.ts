import path from 'node:path'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'

export interface TeamTaskFlowProjectionState {
  runId: string
  flowId: string
  revision: number
  updatedAt: number
}

export class FileTaskFlowProjectionStore {
  async read(runtimeRoot: string): Promise<TeamTaskFlowProjectionState | null> {
    return await readJsonFile<TeamTaskFlowProjectionState>(this.statePath(runtimeRoot))
  }

  async write(runtimeRoot: string, state: TeamTaskFlowProjectionState): Promise<void> {
    await atomicWriteJson(this.statePath(runtimeRoot), state)
  }

  private statePath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'managed', 'task-flow-projection.json')
  }
}
