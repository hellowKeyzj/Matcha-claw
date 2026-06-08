import path from 'node:path'
import type { TeamGateFailureItem, TeamGateResult } from '../domain/team-gate.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileGateStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
}

export interface SaveGateInput {
  runtimeRoot: string
  runId: string
  stageId: string
  artifactId: string
  gateType: string
  verdict: string
  passed: boolean
  failureItems: TeamGateFailureItem[]
  idempotencyKey: string
}

export class FileGateStore {
  constructor(private readonly deps: FileGateStoreDeps) {}

  async save(input: SaveGateInput): Promise<{ gate: TeamGateResult; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'gates.lock'), async () => {
      const gates = await this.read(input.runtimeRoot)
      const existing = gates.find((gate) => gate.idempotencyKey === input.idempotencyKey)
      if (existing) {
        return { gate: existing, created: false }
      }

      const gate: TeamGateResult = {
        gateId: this.deps.idGenerator.randomId(),
        runId: input.runId,
        stageId: input.stageId,
        artifactId: input.artifactId,
        gateType: input.gateType,
        verdict: input.verdict,
        passed: input.passed,
        failureItems: input.failureItems,
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
      }
      await atomicWriteJson(this.gatesPath(input.runtimeRoot), [...gates, gate])
      return { gate, created: true }
    })
  }

  async read(runtimeRoot: string): Promise<TeamGateResult[]> {
    return await readJsonFile<TeamGateResult[]>(this.gatesPath(runtimeRoot)) ?? []
  }

  private gatesPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'gates', 'gates.json')
  }
}
