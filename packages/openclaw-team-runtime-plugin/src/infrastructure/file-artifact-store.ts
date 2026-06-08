import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TeamArtifact } from '../domain/team-artifact.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileArtifactStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
  maxContentBytes?: number
}

export interface SubmitArtifactInput {
  runtimeRoot: string
  runId: string
  stageId: string
  roleId: string
  kind: string
  title: string
  content: string
  summary?: string
  idempotencyKey: string
}

export class FileArtifactStore {
  constructor(private readonly deps: FileArtifactStoreDeps) {}

  async submit(input: SubmitArtifactInput): Promise<{ artifact: TeamArtifact; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'artifacts.lock'), async () => {
      const artifacts = await this.read(input.runtimeRoot)
      const existing = artifacts.find((artifact) => artifact.idempotencyKey === input.idempotencyKey)
      if (existing) {
        return { artifact: existing, created: false }
      }

      const contentBytes = Buffer.byteLength(input.content, 'utf8')
      const maxContentBytes = this.deps.maxContentBytes
      if (maxContentBytes !== undefined && contentBytes > maxContentBytes) {
        throw new Error(`Team artifact content exceeds ${maxContentBytes} bytes`)
      }

      const artifactId = this.deps.idGenerator.randomId()
      const contentRef = path.join('artifacts', 'blobs', `${artifactId}.md`)
      const artifact: TeamArtifact = {
        artifactId,
        runId: input.runId,
        stageId: input.stageId,
        roleId: input.roleId,
        kind: input.kind,
        title: input.title,
        contentRef,
        ...(input.summary ? { summary: input.summary } : {}),
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
      }

      await mkdir(path.join(input.runtimeRoot, 'artifacts', 'blobs'), { recursive: true })
      await writeFile(path.join(input.runtimeRoot, contentRef), input.content, 'utf8')
      await atomicWriteJson(this.artifactsPath(input.runtimeRoot), [...artifacts, artifact])
      return { artifact, created: true }
    })
  }

  async read(runtimeRoot: string): Promise<TeamArtifact[]> {
    return await readJsonFile<TeamArtifact[]>(this.artifactsPath(runtimeRoot)) ?? []
  }

  async readContent(runtimeRoot: string, artifact: TeamArtifact): Promise<string> {
    return await readFile(path.join(runtimeRoot, artifact.contentRef), 'utf8')
  }

  private artifactsPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'artifacts', 'artifacts.json')
  }
}
