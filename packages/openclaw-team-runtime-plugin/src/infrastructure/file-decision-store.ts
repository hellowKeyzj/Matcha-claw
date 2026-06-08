import path from 'node:path'
import type { TeamDecision, TeamDecisionType } from '../domain/team-decision.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileDecisionStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
}

export interface SaveDecisionInput {
  runtimeRoot: string
  runId: string
  stageId: string
  decision: TeamDecisionType
  note?: string
  idempotencyKey: string
}

export class FileDecisionStore {
  constructor(private readonly deps: FileDecisionStoreDeps) {}

  async save(input: SaveDecisionInput): Promise<{ decision: TeamDecision; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'decisions.lock'), async () => {
      const decisions = await this.read(input.runtimeRoot)
      const existing = decisions.find((decision) => decision.idempotencyKey === input.idempotencyKey)
      if (existing) {
        return { decision: existing, created: false }
      }

      const decision: TeamDecision = {
        decisionId: this.deps.idGenerator.randomId(),
        runId: input.runId,
        stageId: input.stageId,
        decision: input.decision,
        ...(input.note ? { note: input.note } : {}),
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
      }
      await atomicWriteJson(this.decisionsPath(input.runtimeRoot), [...decisions, decision])
      return { decision, created: true }
    })
  }

  async read(runtimeRoot: string): Promise<TeamDecision[]> {
    return await readJsonFile<TeamDecision[]>(this.decisionsPath(runtimeRoot)) ?? []
  }

  private decisionsPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'decisions', 'decisions.json')
  }
}
