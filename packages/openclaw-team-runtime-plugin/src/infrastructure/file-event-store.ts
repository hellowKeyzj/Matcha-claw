import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { TeamEvent } from '../domain/team-event.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'

export interface FileEventStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
}

export class FileEventStore {
  constructor(private readonly deps: FileEventStoreDeps) {}

  async append(input: {
    runtimeRoot: string
    runId: string
    revision: number
    type: string
    payload: Record<string, unknown>
  }): Promise<TeamEvent> {
    await mkdir(input.runtimeRoot, { recursive: true })
    const event: TeamEvent = {
      eventId: this.deps.idGenerator.randomId(),
      runId: input.runId,
      revision: input.revision,
      type: input.type,
      payload: input.payload,
      createdAt: this.deps.clock.nowMs(),
    }
    await appendFile(this.eventsPath(input.runtimeRoot), `${JSON.stringify(event)}\n`, 'utf8')
    return event
  }

  async read(input: { runtimeRoot: string; cursor?: number; limit?: number }): Promise<{ events: TeamEvent[]; nextCursor: number }> {
    const raw = await this.readRawEvents(input.runtimeRoot)
    const lines = raw.split('\n')
    const start = Math.max(0, input.cursor ?? 0)
    const limit = Math.max(1, Math.min(input.limit ?? 200, 2_000))
    const selected = lines.slice(start).filter((line) => line.trim()).slice(0, limit)
    return {
      events: selected.map((line) => JSON.parse(line) as TeamEvent),
      nextCursor: start + selected.length,
    }
  }

  private async readRawEvents(runtimeRoot: string): Promise<string> {
    try {
      return await readFile(this.eventsPath(runtimeRoot), 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return ''
      }
      throw error
    }
  }

  private eventsPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'events.jsonl')
  }
}
