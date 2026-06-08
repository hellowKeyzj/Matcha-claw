import path from 'node:path'
import type { TeamGateFailureItem } from '../domain/team-gate.js'
import type { TeamKickback } from '../domain/team-kickback.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileKickbackStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
}

export interface SaveKickbackInput {
  runtimeRoot: string
  runId: string
  stageId: string
  gateId: string
  failureItems: TeamGateFailureItem[]
  idempotencyKey: string
}

export class FileKickbackStore {
  constructor(private readonly deps: FileKickbackStoreDeps) {}

  async save(input: SaveKickbackInput): Promise<{ kickback: TeamKickback; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'kickbacks.lock'), async () => {
      const kickbacks = await this.read(input.runtimeRoot)
      const existing = kickbacks.find((kickback) => kickback.idempotencyKey === input.idempotencyKey)
      if (existing) {
        return { kickback: existing, created: false }
      }

      const kickback: TeamKickback = {
        kickbackId: this.deps.idGenerator.randomId(),
        runId: input.runId,
        stageId: input.stageId,
        gateId: input.gateId,
        failureItems: input.failureItems,
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
      }
      await atomicWriteJson(this.kickbacksPath(input.runtimeRoot), [...kickbacks, kickback])
      return { kickback, created: true }
    })
  }

  async read(runtimeRoot: string): Promise<TeamKickback[]> {
    return await readJsonFile<TeamKickback[]>(this.kickbacksPath(runtimeRoot)) ?? []
  }

  private kickbacksPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'kickbacks', 'kickbacks.json')
  }
}
