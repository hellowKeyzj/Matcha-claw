import type { TeamRunStatus } from './domain/team-run';

export interface TeamRunRegistryRecord {
  readonly teamId?: string;
  readonly runId: string;
  readonly status: TeamRunStatus;
  readonly revision: number;
  readonly updatedAt: number;
}

const TERMINAL_TEAM_RUN_STATUSES = new Set<TeamRunStatus>(['completed', 'failed', 'cancelled']);

export function isTerminalTeamRunStatus(status: TeamRunStatus): boolean {
  return TERMINAL_TEAM_RUN_STATUSES.has(status);
}

export class TeamRunRegistry {
  private readonly runsById = new Map<string, TeamRunRegistryRecord>();
  private readonly runIdsByTeamId = new Map<string, Set<string>>();

  upsert(run: TeamRunRegistryRecord): void {
    const previous = this.runsById.get(run.runId);
    if (previous?.teamId && previous.teamId !== run.teamId) {
      this.removeFromTeam(previous.teamId, run.runId);
    }
    this.runsById.set(run.runId, { ...run });
    if (run.teamId) {
      const runIds = this.runIdsByTeamId.get(run.teamId) ?? new Set<string>();
      runIds.add(run.runId);
      this.runIdsByTeamId.set(run.teamId, runIds);
    }
  }

  remove(runId: string): void {
    const previous = this.runsById.get(runId);
    if (previous?.teamId) {
      this.removeFromTeam(previous.teamId, runId);
    }
    this.runsById.delete(runId);
  }

  removeTeam(teamId: string): void {
    const runIds = this.runIdsByTeamId.get(teamId);
    if (!runIds) return;
    for (const runId of runIds) {
      this.runsById.delete(runId);
    }
    this.runIdsByTeamId.delete(teamId);
  }

  listRunIdsByTeamId(teamId: string): string[] {
    return Array.from(this.runIdsByTeamId.get(teamId) ?? []);
  }

  listNonTerminalRunIds(): string[] {
    return Array.from(this.runsById.values())
      .filter((run) => !isTerminalTeamRunStatus(run.status))
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map((run) => run.runId);
  }

  hasNonTerminalRuns(): boolean {
    for (const run of this.runsById.values()) {
      if (!isTerminalTeamRunStatus(run.status)) return true;
    }
    return false;
  }

  private removeFromTeam(teamId: string, runId: string): void {
    const runIds = this.runIdsByTeamId.get(teamId);
    if (!runIds) return;
    runIds.delete(runId);
    if (runIds.size === 0) {
      this.runIdsByTeamId.delete(teamId);
    }
  }
}
