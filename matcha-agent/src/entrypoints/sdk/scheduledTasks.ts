import {
  buildMissedTaskNotification as formatMissedTaskNotification,
  createCronScheduler,
} from '../../utils/cronScheduler.js'
export type CronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  lastFiredAt?: number
  recurring?: boolean
  permanent?: boolean
  durable?: boolean
  agentId?: string
}

export type CronJitterConfig = {
  recurringFrac: number
  recurringCapMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
  recurringMaxAgeMs: number
}

export type ScheduledTaskEvent =
  | { type: 'fire'; task: CronTask }
  | { type: 'missed'; tasks: CronTask[] }

export type ScheduledTasksHandle = {
  events(): AsyncGenerator<ScheduledTaskEvent>
  getNextFireTime(): number | null
}

export function watchScheduledTasks(opts: {
  dir: string
  signal: AbortSignal
  getJitterConfig?: () => CronJitterConfig
}): ScheduledTasksHandle {
  const queue: ScheduledTaskEvent[] = []
  const waiters: Array<(event: ScheduledTaskEvent | undefined) => void> = []

  const push = (event: ScheduledTaskEvent) => {
    const waiter = waiters.shift()
    if (waiter) waiter(event)
    else queue.push(event)
  }

  const scheduler = createCronScheduler({
    dir: opts.dir,
    getJitterConfig: opts.getJitterConfig,
    isLoading: () => false,
    onFire: prompt => {
      push({
        type: 'fire',
        task: {
          id: `prompt:${Date.now()}`,
          cron: '* * * * *',
          prompt,
          createdAt: Date.now(),
          recurring: false,
        },
      })
    },
    onFireTask: task => push({ type: 'fire', task }),
    onMissed: tasks => push({ type: 'missed', tasks }),
  })

  opts.signal.addEventListener('abort', () => {
    scheduler.stop()
    for (const waiter of waiters.splice(0)) waiter(undefined)
  })
  scheduler.start()

  return {
    async *events() {
      while (!opts.signal.aborted) {
        const existing = queue.shift()
        if (existing) {
          yield existing
          continue
        }
        const next = await new Promise<ScheduledTaskEvent | undefined>(
          resolve => waiters.push(resolve),
        )
        if (!next) return
        yield next
      }
    },
    getNextFireTime() {
      return scheduler.getNextFireTime()
    },
  }
}

export function buildMissedTaskNotification(missed: CronTask[]): string {
  return formatMissedTaskNotification(missed)
}
