import type { TeamDirtyRun } from './domain/team-outbox';
import type { TeamRunRegistry } from './team-run-registry';
import type { TeamRuntimePort } from './team-runtime-port';

export interface TeamRuntimeDirtyRunStore {
  listDirtyRuns(): Promise<readonly TeamDirtyRun[]>;
}

export interface TeamRuntimeOutboxPollerDeps {
  readonly runRegistry: TeamRunRegistry;
  readonly dirtyRunStore: TeamRuntimeDirtyRunStore;
  readonly teamRuntimeService: TeamRuntimePort;
  readonly nowMs: () => number;
  readonly idleDelayMs?: number;
  readonly activeDelayMs?: number;
  readonly errorDelayMs?: number;
}

const DEFAULT_IDLE_DELAY_MS = 3_000;
const DEFAULT_ACTIVE_DELAY_MS = 1_000;
const DEFAULT_ERROR_DELAY_MS = 6_000;

export class TeamRuntimeOutboxPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private closed = false;

  constructor(private readonly deps: TeamRuntimeOutboxPollerDeps) {}

  refresh(): void {
    if (this.closed) return;
    if (!this.deps.runRegistry.hasNonTerminalRuns()) {
      this.clearTimer();
      return;
    }
    if (this.running || this.timer) return;
    this.schedule(0);
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (!this.deps.runRegistry.hasNonTerminalRuns()) {
      this.clearTimer();
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce();
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (this.closed || this.running) return;
    if (!this.deps.runRegistry.hasNonTerminalRuns()) return;
    this.running = true;
    try {
      const activeRunIds = new Set(this.deps.runRegistry.listNonTerminalRunIds());
      if (activeRunIds.size === 0) return;
      const dirtyRuns = await this.deps.dirtyRunStore.listDirtyRuns();
      const targets = dirtyRuns.filter((dirtyRun) => activeRunIds.has(dirtyRun.runId));
      if (targets.length > 0) {
        await Promise.all(targets.map((dirtyRun) => this.tickDirtyRun(dirtyRun)));
      }
      this.schedule(targets.length > 0 ? this.activeDelayMs : this.idleDelayMs);
    } catch {
      this.schedule(this.errorDelayMs);
    } finally {
      this.running = false;
    }
  }

  private async tickDirtyRun(dirtyRun: TeamDirtyRun): Promise<void> {
    await this.deps.teamRuntimeService.invoke('team.runTick', {
      runId: dirtyRun.runId,
      idempotencyKey: `team-runtime-poller:${dirtyRun.runId}:${dirtyRun.latestSequence}:${this.deps.nowMs()}`,
    });
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private get idleDelayMs(): number {
    return this.deps.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
  }

  private get activeDelayMs(): number {
    return this.deps.activeDelayMs ?? DEFAULT_ACTIVE_DELAY_MS;
  }

  private get errorDelayMs(): number {
    return this.deps.errorDelayMs ?? DEFAULT_ERROR_DELAY_MS;
  }
}
