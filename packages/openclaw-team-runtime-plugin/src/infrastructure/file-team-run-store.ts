import path from 'node:path'
import type { TeamRun, TeamRunStatus } from '../domain/team-run.js'
import type { ClockPort } from '../ports/clock-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileTeamRunStoreDeps {
  clock: ClockPort
}

export class FileTeamRunStore {
  constructor(private readonly deps: FileTeamRunStoreDeps) {}

  async create(input: {
    runtimeRoot: string
    runId: string
    packageName: string
    packageVersion: string
    sourcePath: string
  }): Promise<TeamRun> {
    return await this.withRunLock(input.runtimeRoot, async () => {
      const existing = await this.read(input.runtimeRoot)
      if (existing) {
        return existing
      }

      const now = this.deps.clock.nowMs()
      const run: TeamRun = {
        runId: input.runId,
        packageName: input.packageName,
        packageVersion: input.packageVersion,
        sourcePath: input.sourcePath,
        status: 'created',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
      await atomicWriteJson(this.runPath(input.runtimeRoot), run)
      return run
    })
  }

  async read(runtimeRoot: string): Promise<TeamRun | null> {
    return await readJsonFile<TeamRun>(this.runPath(runtimeRoot))
  }

  async update(input: {
    runtimeRoot: string
    status?: TeamRunStatus
    currentStageId?: string
  }): Promise<TeamRun> {
    return await this.withRunLock(input.runtimeRoot, async () => {
      const current = await this.read(input.runtimeRoot)
      if (!current) {
        throw new Error('TeamRun is not initialized')
      }

      const next: TeamRun = {
        ...current,
        ...(input.status ? { status: input.status } : {}),
        ...(input.currentStageId !== undefined ? { currentStageId: input.currentStageId } : {}),
        revision: current.revision + 1,
        updatedAt: this.deps.clock.nowMs(),
      }
      await atomicWriteJson(this.runPath(input.runtimeRoot), next)
      return next
    })
  }

  async withRunLock<T>(runtimeRoot: string, task: () => Promise<T>): Promise<T> {
    return await withFileLock(path.join(runtimeRoot, 'locks', 'run.lock'), task)
  }

  private runPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'run.json')
  }
}
