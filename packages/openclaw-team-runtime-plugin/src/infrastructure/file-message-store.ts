import path from 'node:path'
import type { TeamMessage } from '../domain/team-message.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileMessageStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
  maxBodyBytes?: number
}

export interface SendMessageInput {
  runtimeRoot: string
  runId: string
  fromRoleId: string
  toRoleId: string
  summary: string
  body: string
  idempotencyKey: string
}

export class FileMessageStore {
  constructor(private readonly deps: FileMessageStoreDeps) {}

  async send(input: SendMessageInput): Promise<{ message: TeamMessage; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'messages.lock'), async () => {
      const messages = await this.read(input.runtimeRoot)
      const existing = messages.find((message) => message.idempotencyKey === input.idempotencyKey)
      if (existing) {
        return { message: existing, created: false }
      }

      const bodyBytes = Buffer.byteLength(input.body, 'utf8')
      const maxBodyBytes = this.deps.maxBodyBytes
      if (maxBodyBytes !== undefined && bodyBytes > maxBodyBytes) {
        throw new Error(`Team message body exceeds ${maxBodyBytes} bytes`)
      }

      const message: TeamMessage = {
        messageId: this.deps.idGenerator.randomId(),
        runId: input.runId,
        fromRoleId: input.fromRoleId,
        toRoleId: input.toRoleId,
        summary: input.summary,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
      }
      await atomicWriteJson(this.messagesPath(input.runtimeRoot), [...messages, message])
      return { message, created: true }
    })
  }

  async read(runtimeRoot: string): Promise<TeamMessage[]> {
    return await readJsonFile<TeamMessage[]>(this.messagesPath(runtimeRoot)) ?? []
  }

  private messagesPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'mailbox', 'messages.json')
  }
}
