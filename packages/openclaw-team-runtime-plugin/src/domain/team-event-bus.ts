export type TeamEventType =
  | 'task:created'
  | 'message:created'
  | 'workflow:task_completed'
  | 'workflow:execution_stale'
  | 'workflow:group_settled'
  | 'poll:task'
  | 'poll:message'
  | 'shutdown'

export interface TeamEvent {
  type: TeamEventType
  runId: string
  timestamp: number
}

export interface TeamEventHandler {
  handle(event: TeamEvent): Promise<void>
}

export class TeamEventBus {
  private queue: TeamEvent[] = []
  private waiters: Array<(event: TeamEvent) => void> = []
  private handlers = new Map<string, TeamEventHandler[]>()
  private running = false
  private loopTask: Promise<void> | null = null
  private pollTasks: Promise<void>[] = []
  private runId = ''

  isRunningForRun(runId: string): boolean {
    return this.running && this.runId === runId
  }

  on(eventType: TeamEventType, handler: TeamEventHandler): void {
    const existing = this.handlers.get(eventType) ?? []
    existing.push(handler)
    this.handlers.set(eventType, existing)
  }

  enqueue(event: TeamEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(event)
    } else {
      this.queue.push(event)
    }
  }

  async start(runId: string, pollIntervals?: { task?: number; message?: number }): Promise<void> {
    if (this.isRunningForRun(runId)) {
      return
    }
    if (this.running) {
      await this.stop()
    }
    this.runId = runId
    this.running = true
    this.loopTask = this.runLoop()
    const taskInterval = pollIntervals?.task ?? 30_000
    const messageInterval = pollIntervals?.message ?? 30_000
    this.pollTasks = [
      this.pollLoop('poll:task', taskInterval),
      this.pollLoop('poll:message', messageInterval),
    ]
  }

  async stop(): Promise<void> {
    this.running = false
    // Wake up any waiting consumer so runLoop can exit
    for (const waiter of this.waiters) {
      waiter({ type: 'shutdown', runId: '', timestamp: 0 })
    }
    this.waiters = []
    this.enqueue({ type: 'shutdown', runId: '', timestamp: 0 })
    if (this.loopTask) {
      await Promise.race([this.loopTask, new Promise((r) => setTimeout(r, 5000))])
    }
    this.pollTasks = []
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const event = await this.nextEvent()
      if (event.type === 'shutdown') break
      await this.dispatch(event)
    }
  }

  private async pollLoop(eventType: string, interval: number): Promise<void> {
    while (this.running) {
      await new Promise((r) => setTimeout(r, interval))
      if (!this.running) break
      this.enqueue({ type: eventType as TeamEventType, runId: this.runId, timestamp: Date.now() })
    }
  }

  private nextEvent(): Promise<TeamEvent> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!)
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  private async dispatch(event: TeamEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? []
    for (const handler of handlers) {
      try {
        await handler.handle(event)
      } catch (error) {
        console.error(`[EventBus] handler error for ${event.type}:`, error)
      }
    }
  }
}
