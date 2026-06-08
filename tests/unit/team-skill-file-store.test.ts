import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClockPort } from '../../packages/openclaw-team-runtime-plugin/src/ports/clock-port'
import type { IdGeneratorPort } from '../../packages/openclaw-team-runtime-plugin/src/ports/id-generator-port'
import { atomicWriteJson, readJsonFile } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/atomic-json'
import { FileArtifactStore } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/file-artifact-store'
import { FileDecisionStore } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/file-decision-store'
import { FileEventStore } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/file-event-store'
import { FileMessageStore } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/file-message-store'
import { FileTeamRunStore } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/file-team-run-store'
import { withFileLock } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/file-lock'

class SequenceClock implements ClockPort {
  private current = 1_000

  nowMs(): number {
    this.current += 1
    return this.current
  }
}

class SequenceIds implements IdGeneratorPort {
  private current = 0

  randomId(): string {
    this.current += 1
    return `id-${this.current}`
  }
}

describe('TeamSkill file store primitives', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'team-skill-store-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes and reads JSON atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'run.json')

    await atomicWriteJson(filePath, { runId: 'run-1', revision: 1 })

    await expect(readJsonFile(filePath)).resolves.toEqual({ runId: 'run-1', revision: 1 })
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"runId": "run-1"')
  })

  it('serializes concurrent work with a file lock', async () => {
    const lockPath = path.join(tempDir, 'locks', 'run.lock')
    const events: string[] = []
    let activeCount = 0
    let maxActiveCount = 0
    let releaseLongTask: () => void = () => {}
    const longTaskCanFinish = new Promise<void>((resolve) => {
      releaseLongTask = resolve
    })

    const longTask = withFileLock(lockPath, async () => {
      activeCount += 1
      maxActiveCount = Math.max(maxActiveCount, activeCount)
      events.push('long:start')
      await longTaskCanFinish
      events.push('long:end')
      activeCount -= 1
      return 'long'
    })
    const shortTask = withFileLock(lockPath, async () => {
      activeCount += 1
      maxActiveCount = Math.max(maxActiveCount, activeCount)
      events.push('short:start')
      events.push('short:end')
      activeCount -= 1
      return 'short'
    })

    await until(() => events.some((event) => event.endsWith(':start')))
    releaseLongTask()

    await expect(Promise.all([longTask, shortTask])).resolves.toEqual(['long', 'short'])
    expect(maxActiveCount).toBe(1)
    expect(events).toHaveLength(4)
  })

  it('creates and updates TeamRun under the run lock', async () => {
    const store = new FileTeamRunStore({ clock: new SequenceClock() })

    const created = await store.create({
      runtimeRoot: tempDir,
      runId: 'run-1',
      packageName: 'pkg',
      packageVersion: '0.1',
      sourcePath: '/pkg',
    })
    const updated = await store.update({ runtimeRoot: tempDir, status: 'running', currentStageId: 'stage-1' })

    expect(created.revision).toBe(1)
    expect(updated).toEqual(expect.objectContaining({
      runId: 'run-1',
      status: 'running',
      currentStageId: 'stage-1',
      revision: 2,
    }))
    await expect(store.read(tempDir)).resolves.toEqual(updated)
  })

  it('appends JSONL events and reads by cursor', async () => {
    const store = new FileEventStore({ clock: new SequenceClock(), idGenerator: new SequenceIds() })

    await store.append({ runtimeRoot: tempDir, runId: 'run-1', revision: 1, type: 'run:created', payload: { ok: true } })
    await store.append({ runtimeRoot: tempDir, runId: 'run-1', revision: 2, type: 'stage:started', payload: { stageId: 'stage-1' } })

    const firstPage = await store.read({ runtimeRoot: tempDir, cursor: 0, limit: 1 })
    const secondPage = await store.read({ runtimeRoot: tempDir, cursor: firstPage.nextCursor, limit: 10 })

    expect(firstPage.events).toEqual([expect.objectContaining({ eventId: 'id-1', type: 'run:created' })])
    expect(firstPage.nextCursor).toBe(1)
    expect(secondPage.events).toEqual([expect.objectContaining({ eventId: 'id-2', type: 'stage:started' })])
    await expect(readFile(path.join(tempDir, 'events.jsonl'), 'utf8')).resolves.toContain('stage:started')
  })

  it('rejects artifacts and messages that exceed configured size caps', async () => {
    const artifactStore = new FileArtifactStore({ clock: new SequenceClock(), idGenerator: new SequenceIds(), maxContentBytes: 4 })
    const messageStore = new FileMessageStore({ clock: new SequenceClock(), idGenerator: new SequenceIds(), maxBodyBytes: 4 })

    await expect(artifactStore.submit({
      runtimeRoot: tempDir,
      runId: 'run-1',
      stageId: 'stage-1',
      roleId: 'role-1',
      kind: 'design_report',
      title: 'Too large',
      content: '12345',
      idempotencyKey: 'large-artifact',
    })).rejects.toThrow('Team artifact content exceeds 4 bytes')
    await expect(messageStore.send({
      runtimeRoot: tempDir,
      runId: 'run-1',
      fromRoleId: 'role-1',
      toRoleId: 'leader',
      summary: 'Too large',
      body: '12345',
      idempotencyKey: 'large-message',
    })).rejects.toThrow('Team message body exceeds 4 bytes')
  })

  it('stores artifacts, messages, and decisions idempotently by idempotency key', async () => {
    const clock = new SequenceClock()
    const ids = new SequenceIds()
    const artifactStore = new FileArtifactStore({ clock, idGenerator: ids })
    const messageStore = new FileMessageStore({ clock, idGenerator: ids })
    const decisionStore = new FileDecisionStore({ clock, idGenerator: ids })

    const firstArtifact = await artifactStore.submit({
      runtimeRoot: tempDir,
      runId: 'run-1',
      stageId: 'stage-1',
      roleId: 'role-1',
      kind: 'design_report',
      title: 'Design',
      content: 'first content',
      idempotencyKey: 'artifact-key',
    })
    const secondArtifact = await artifactStore.submit({
      runtimeRoot: tempDir,
      runId: 'run-1',
      stageId: 'stage-1',
      roleId: 'role-1',
      kind: 'design_report',
      title: 'Changed',
      content: 'changed content',
      idempotencyKey: 'artifact-key',
    })
    const firstMessage = await messageStore.send({
      runtimeRoot: tempDir,
      runId: 'run-1',
      fromRoleId: 'role-1',
      toRoleId: 'leader',
      summary: 'Ready',
      body: 'Artifact ready.',
      idempotencyKey: 'message-key',
    })
    const secondMessage = await messageStore.send({
      runtimeRoot: tempDir,
      runId: 'run-1',
      fromRoleId: 'role-1',
      toRoleId: 'leader',
      summary: 'Changed',
      body: 'Changed body.',
      idempotencyKey: 'message-key',
    })
    const firstDecision = await decisionStore.save({
      runtimeRoot: tempDir,
      runId: 'run-1',
      stageId: 'stage-1',
      decision: 'retry',
      idempotencyKey: 'decision-key',
    })
    const secondDecision = await decisionStore.save({
      runtimeRoot: tempDir,
      runId: 'run-1',
      stageId: 'stage-1',
      decision: 'abort',
      idempotencyKey: 'decision-key',
    })

    expect(firstArtifact.created).toBe(true)
    expect(secondArtifact).toEqual({ artifact: firstArtifact.artifact, created: false })
    expect(await artifactStore.readContent(tempDir, firstArtifact.artifact)).toBe('first content')
    expect(firstMessage.created).toBe(true)
    expect(secondMessage).toEqual({ message: firstMessage.message, created: false })
    expect(firstDecision.created).toBe(true)
    expect(secondDecision).toEqual({ decision: firstDecision.decision, created: false })
  })
})

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for condition')
}
