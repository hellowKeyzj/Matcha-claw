import type {
  AppServerEvent,
  AppServerEventEnvelope,
} from '../protocol/types.js'

export type SessionEventFields = {
  runId?: string
  workerId?: string
}

export type SessionEventPostAppendStage =
  | 'sessionMetadata'
  | 'snapshot'
  | 'publish'

export type SessionEventCommitterPorts = {
  append(
    sessionId: string,
    event: AppServerEvent,
    fields: SessionEventFields,
  ): Promise<AppServerEventEnvelope>
  updateSessionMetadata(envelope: AppServerEventEnvelope): Promise<void>
  updateSnapshot(envelope: AppServerEventEnvelope): Promise<void>
  publish(envelope: AppServerEventEnvelope): void
  reportPostAppendFailure(
    stage: SessionEventPostAppendStage,
    envelope: AppServerEventEnvelope,
    error: unknown,
  ): void
}

export class SessionEventCommitter {
  private readonly commitTails = new Map<string, Promise<void>>()

  constructor(private readonly ports: SessionEventCommitterPorts) {}

  commit(
    sessionId: string,
    event: AppServerEvent,
    fields: SessionEventFields = {},
  ): Promise<AppServerEventEnvelope> {
    const eventFields = { ...fields }
    const previousCommit = this.commitTails.get(sessionId) ?? Promise.resolve()
    const commitOperation = previousCommit.then(() =>
      this.commitAfterPrevious(sessionId, event, eventFields),
    )
    const commitTail = commitOperation.then(
      () => undefined,
      () => undefined,
    )

    this.commitTails.set(sessionId, commitTail)
    void commitTail.finally(() => {
      if (this.commitTails.get(sessionId) === commitTail) {
        this.commitTails.delete(sessionId)
      }
    })

    return commitOperation
  }

  private async commitAfterPrevious(
    sessionId: string,
    event: AppServerEvent,
    fields: SessionEventFields,
  ): Promise<AppServerEventEnvelope> {
    const envelope = await this.ports.append(sessionId, event, fields)

    await this.completePostAppendStage(
      'sessionMetadata',
      envelope,
      () => this.ports.updateSessionMetadata(envelope),
    )
    await this.completePostAppendStage('snapshot', envelope, () =>
      this.ports.updateSnapshot(envelope),
    )
    await this.completePostAppendStage('publish', envelope, () => {
      this.ports.publish(envelope)
    })

    return envelope
  }

  private async completePostAppendStage(
    stage: SessionEventPostAppendStage,
    envelope: AppServerEventEnvelope,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await operation()
    } catch (error) {
      try {
        this.ports.reportPostAppendFailure(stage, envelope, error)
      } catch {
        // Reporting must not poison this session's commit queue.
      }
    }
  }
}
